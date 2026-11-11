import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { StringDecoder } from 'string_decoder';
import { randomBytes } from 'crypto';
import { checkSystem, getSystemCheckFilePath, readSystemCheck, SystemCheckResult } from './system-check';

const viewType = 'workflowSidebar';
const welcomePanelType = 'urworkfolw.welcome';
let welcomePanel: vscode.WebviewPanel | undefined;

type DependencyPhase = 'checking' | 'ready' | 'none' | 'installing' | 'complete' | 'error';
type DependencyUiState = { phase: DependencyPhase; message: string };
type ScriptResult = { type: 'result'; ok: boolean; exitCode: number; logs?: string[] };

const dependencyManifestNames = new Set([
  'pipfile', 'pipfile.lock', 'pyproject.toml', 'poetry.lock', 'uv.lock',
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb',
  'go.mod', 'cargo.toml', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'gemfile', 'composer.json',
  'mix.exs', 'package.swift'
]);

export function activate(context: vscode.ExtensionContext) {
  console.log('Congratulations, your extension "urworkfolw" is now active!');

  const openWelcome = () => openWelcomePanel(context);
  let viewProvider: WorkflowViewProvider;
  viewProvider = new WorkflowViewProvider(
    context.extensionUri,
    openWelcome,
    () => runDependencyInstall(context, viewProvider)
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      viewType,
      viewProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    ),
    vscode.commands.registerCommand('urworkfolw.helloWorld', () => {
      vscode.window.showInformationMessage('Hello World from UR_workfolw!');
    }),
    vscode.commands.registerCommand('urworkfolw.openWelcome', openWelcome),
    vscode.commands.registerCommand('urworkfolw.systemCheck', async () => {
      try {
        await checkSystem();
        const result = await readSystemCheck();
        const outputPath = vscode.Uri.file(getSystemCheckFilePath()).fsPath;
        await vscode.window.showInformationMessage(
          `系统检查完成：${result.operatingSystem} / ${result.architecture}；Python ${result.python.installed ? '已安装' : '未安装'}；Git ${result.git.installed ? '已安装' : '未安装'}。结果已写入 ${outputPath}`
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await vscode.window.showErrorMessage(`系统检查失败：${message}`);
      }
    }),
    vscode.commands.registerCommand('urworkfolw.installDependencies', () => runDependencyInstall(context, viewProvider)),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void inspectWorkspaceDependencies(context, viewProvider);
    })
  );

  void inspectWorkspaceDependencies(context, viewProvider);

  // Run the system check and guide the user on the first activation after this feature is installed.
  const hasCompletedSystemCheck = context.globalState.get<boolean>('hasCompletedSystemCheck', false);
  if (!hasCompletedSystemCheck) {
    void openWelcomePanel(context, true);
  } else if (!context.globalState.get<boolean>('hasShownWelcome', false)) {
    void openWelcome();
    void context.globalState.update('hasShownWelcome', true);
  }
}

async function inspectWorkspaceDependencies(
  context: vscode.ExtensionContext,
  provider: WorkflowViewProvider
): Promise<void> {
  const folder = getTargetWorkspaceFolder();
  if (!folder) {
    provider.setDependencyState({ phase: 'none', message: '打开一个项目工作区后即可检查依赖。' });
    return;
  }

  try {
    const entries = await vscode.workspace.fs.readDirectory(folder.uri);
    const manifests = entries
      .map(([name]) => name)
      .filter((name) => {
        const lowerName = name.toLowerCase();
        return dependencyManifestNames.has(lowerName) || /^requirements.*\.txt$/i.test(name)
          || lowerName.endsWith('.sln') || lowerName.endsWith('.csproj');
      });

    if (manifests.length === 0) {
      provider.setDependencyState({ phase: 'none', message: '未发现支持的依赖清单。' });
      return;
    }

    provider.setDependencyState({
      phase: 'ready',
      message: `检测到依赖清单：${manifests.join('、')}。可以一键检测/安装。`
    });

    const promptKey = `dependencyPrompted:${encodeURIComponent(folder.uri.toString())}`;
    if (!context.globalState.get<boolean>(promptKey, false)) {
      await context.globalState.update(promptKey, true);
      const choice = await vscode.window.showInformationMessage(
        `检测到 ${folder.name} 包含依赖清单，是否打开侧栏检查并安装？`,
        '打开侧栏'
      );
      if (choice) {
        await vscode.commands.executeCommand('workbench.view.extension.workflowContainer');
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    provider.setDependencyState({ phase: 'error', message: `读取依赖清单失败：${message}` });
  }
}

function getTargetWorkspaceFolder(): vscode.WorkspaceFolder | undefined {
  const activeDocument = vscode.window.activeTextEditor?.document.uri;
  return (activeDocument ? vscode.workspace.getWorkspaceFolder(activeDocument) : undefined)
    ?? vscode.workspace.workspaceFolders?.[0];
}

async function runDependencyInstall(
  context: vscode.ExtensionContext,
  provider: WorkflowViewProvider
): Promise<void> {
  const folder = getTargetWorkspaceFolder();
  if (!folder) {
    const message = '请先打开包含项目依赖清单的工作区。';
    provider.setDependencyState({ phase: 'error', message });
    await vscode.window.showInformationMessage(message);
    return;
  }

  const scriptUri = vscode.Uri.joinPath(context.extensionUri, 'install_dependencies.py');
  provider.setDependencyState({ phase: 'installing', message: '正在启动依赖检测与安装…' });

  const candidates = process.platform === 'win32'
    ? [{ command: 'py', prefix: ['-3'] }, { command: 'python', prefix: [] }]
    : [{ command: 'python3', prefix: [] }, { command: 'python', prefix: [] }];
  const stdoutDecoder = new StringDecoder('utf8');
  let stdoutBuffer = '';
  let result: ScriptResult | undefined;
  let stderrOutput = '';
  let finished = false;

  const finish = async (ok: boolean, message: string) => {
    if (finished) return;
    finished = true;
    provider.setDependencyState({ phase: ok ? 'complete' : 'error', message });
    if (ok) {
      await vscode.window.showInformationMessage(message);
    } else {
      await vscode.window.showErrorMessage(message);
    }
  };

  const consumeLine = (line: string) => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line) as { type?: string; message?: string; ok?: boolean; exitCode?: number; logs?: string[] };
      if (event.type === 'progress' && event.message) {
        provider.setDependencyState({ phase: 'installing', message: event.message });
      } else if (event.type === 'result' && typeof event.ok === 'boolean') {
        result = {
          type: 'result',
          ok: event.ok,
          exitCode: typeof event.exitCode === 'number' ? event.exitCode : 1,
          logs: event.logs
        };
      }
    } catch {
      // The script's stdout is a JSON Lines protocol; ignore malformed lines and report a missing result below.
    }
  };

  const startCandidate = (index: number) => {
    if (index >= candidates.length) {
      void finish(false, '未找到 Python 3。请安装 Python 3 后重试。');
      return;
    }

    const candidate = candidates[index];
    const child = spawn(candidate.command, [
      ...candidate.prefix,
      scriptUri.fsPath,
      folder.uri.fsPath
    ], {
      cwd: folder.uri.fsPath,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let spawnErrorHandled = false;

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBuffer += stdoutDecoder.write(chunk);
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? '';
      lines.forEach(consumeLine);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrOutput = `${stderrOutput}${chunk.toString('utf8')}`.slice(-4000);
    });
    child.once('error', (error: NodeJS.ErrnoException) => {
      spawnErrorHandled = true;
      if (error.code === 'ENOENT' && index + 1 < candidates.length) {
        startCandidate(index + 1);
      } else {
        void finish(false, `无法启动 Python 依赖脚本：${error.message}`);
      }
    });
    child.once('close', (code) => {
      if (spawnErrorHandled || finished) return;
      stdoutBuffer += stdoutDecoder.end();
      if (stdoutBuffer.trim()) consumeLine(stdoutBuffer);

      if (code === 0 && result?.ok) {
        void finish(true, '依赖检测/安装完成。');
      } else {
        const details = result?.logs?.filter((line) => line.includes('[error]')).slice(-3).join('；')
          || stderrOutput.trim().split(/\r?\n/).slice(-3).join('；')
          || `脚本退出码：${code ?? 'unknown'}`;
        void finish(false, `依赖安装失败：${details}`);
      }
    });
  };

  startCandidate(0);
}

function openWelcomePanel(context: vscode.ExtensionContext, runSystemCheck = false): void {
  if (welcomePanel) {
    welcomePanel.reveal(vscode.ViewColumn.One);
    return;
  }

  const mediaUri = vscode.Uri.joinPath(context.extensionUri, 'media');
  const panel = vscode.window.createWebviewPanel(
    welcomePanelType,
    'UR Workflow · 欢迎',
    vscode.ViewColumn.One,
    {
      enableScripts: true,
      localResourceRoots: [mediaUri],
      retainContextWhenHidden: false
    }
  );
  welcomePanel = panel;
  panel.webview.html = getWelcomeHtml(panel.webview, mediaUri);

  let shouldRunSystemCheck = runSystemCheck;
  let loadingWelcomeData: Promise<void> | undefined;

  const sendWelcomeData = async (forceCheck = false) => {
    if (loadingWelcomeData) {
      await loadingWelcomeData;
      if (!forceCheck) return;
    }

    const currentLoad = (async () => {
      try {
        if (forceCheck || shouldRunSystemCheck) await checkSystem();
        const system = await readSystemCheck();
        const configurationSteps = await getConfigurationSteps(system);
        await panel.webview.postMessage({
          type: 'welcomeData',
          payload: {
            title: '欢迎使用 UR Workflow',
            description: '首次启动检查已完成。请查看环境状态，并按需完成下面的配置。',
            version: context.extension.packageJSON.version,
            system,
            configurationSteps,
            reportPath: getSystemCheckFilePath()
          }
        });
        shouldRunSystemCheck = false;
        await context.globalState.update('hasCompletedSystemCheck', true);
        await context.globalState.update('hasShownWelcome', true);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await panel.webview.postMessage({ type: 'welcomeError', message });
      }
    })();
    loadingWelcomeData = currentLoad;

    await currentLoad;
    if (loadingWelcomeData === currentLoad) loadingWelcomeData = undefined;
  };

  panel.webview.onDidReceiveMessage(async (message: unknown) => {
    if (!isWebviewMessage(message)) return;
    switch (message.type) {
      case 'ready':
      case 'requestWelcomeData':
        await sendWelcomeData();
        break;
      case 'runSystemCheck':
        await sendWelcomeData(true);
        break;
      case 'openSidebar':
        await vscode.commands.executeCommand('workbench.view.extension.workflowContainer');
        await panel.webview.postMessage({ type: 'ack', request: 'openSidebar' });
        break;
      case 'openWorkspace':
        await vscode.commands.executeCommand('workbench.action.files.openFolder');
        break;
      case 'installDependencies':
        await vscode.commands.executeCommand('urworkfolw.installDependencies');
        break;
    }
  }, undefined, context.subscriptions);

  panel.onDidDispose(() => {
    if (welcomePanel === panel) welcomePanel = undefined;
  }, undefined, context.subscriptions);
}

interface ConfigurationStep {
  title: string;
  description: string;
  complete: boolean;
  action?: 'openWorkspace' | 'installDependencies';
}

async function getConfigurationSteps(system: SystemCheckResult): Promise<ConfigurationStep[]> {
  const steps: ConfigurationStep[] = [];
  const folder = getTargetWorkspaceFolder();

  if (!folder) {
    steps.push({
      title: '打开项目工作区',
      description: '选择你的项目文件夹，UR Workflow 才能检查项目依赖。',
      complete: false,
      action: 'openWorkspace'
    });
  } else {
    steps.push({
      title: '项目工作区',
      description: folder.uri.fsPath,
      complete: true
    });
    try {
      const entries = await vscode.workspace.fs.readDirectory(folder.uri);
      const manifests = entries.map(([name]) => name).filter((name) => {
        const lowerName = name.toLowerCase();
        return dependencyManifestNames.has(lowerName) || /^requirements.*\.txt$/i.test(name)
          || lowerName.endsWith('.sln') || lowerName.endsWith('.csproj');
      });
      if (manifests.length > 0) {
        steps.push({
          title: '安装项目依赖',
          description: `发现依赖清单：${manifests.join('、')}。确认项目内容后，可运行依赖检测与安装。`,
          complete: false,
          action: 'installDependencies'
        });
      } else {
        steps.push({
          title: '确认项目依赖',
          description: '未发现常见依赖清单；如果项目需要第三方库，请按项目说明安装。',
          complete: false
        });
      }
    } catch {
      steps.push({
        title: '检查项目依赖',
        description: '无法读取工作区内容，请确认当前文件夹可访问。',
        complete: false
      });
    }
  }

  if (!system.python.installed) {
    steps.push({
      title: '安装 Python 3',
      description: '当前未检测到 Python 3。依赖安装功能需要 Python 3 可从命令行启动。',
      complete: false
    });
  }
  if (!system.git.installed) {
    steps.push({
      title: '配置 Git（建议）',
      description: '当前未检测到 Git；如需版本管理或克隆代码，请安装 Git 并加入 PATH。',
      complete: false
    });
  }

  steps.push({
    title: '检查项目专属设置',
    description: '如项目提供 README 或 .env.example，请按说明配置环境变量、密钥和服务地址。',
    complete: false
  });
  return steps;
}

function getWelcomeHtml(webview: vscode.Webview, mediaUri: vscode.Uri): string {
  const welcomeScriptUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'welcome.js'));
  const stylesUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaUri, 'webview', 'styles.css'));
  const nonce = randomBytes(16).toString('base64');

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <link rel="stylesheet" href="${stylesUri}">
  <title>UR Workflow</title>
</head>
<body class="welcome-body">
  <main class="welcome-page">
    <div class="welcome-mark" aria-hidden="true">UR</div>
    <p class="eyebrow">首次启动 · 环境引导</p>
    <h1 id="welcome-title">正在检查运行环境</h1>
    <p class="welcome-description" id="welcome-description" role="status" aria-live="polite">正在检测系统并读取检查结果…</p>

    <form class="onboarding-form" aria-label="系统检查结果">
      <section class="onboarding-section">
        <h2>系统信息</h2>
        <div class="form-grid">
          <label>操作系统<input id="system-os" type="text" readonly value="检查中…"></label>
          <label>系统架构<input id="system-arch" type="text" readonly value="检查中…"></label>
          <label>Python<input id="system-python" type="text" readonly value="检查中…"></label>
          <label>Git<input id="system-git" type="text" readonly value="检查中…"></label>
        </div>
        <p class="report-path" id="report-path"></p>
      </section>
      <section class="onboarding-section">
        <div class="section-title-row"><h2>还需要完成</h2><button class="text-button" id="rerun-check" type="button">重新检查</button></div>
        <ul class="setup-list" id="setup-list"><li>正在整理配置建议…</li></ul>
      </section>
      <p class="welcome-error" id="welcome-error" role="alert" hidden></p>
      <div class="welcome-actions">
        <button class="primary-button" id="open-sidebar" type="button">打开侧边栏 <span aria-hidden="true">→</span></button>
      </div>
    </form>
    <p class="welcome-version" id="welcome-version"></p>
  </main>
  <script nonce="${nonce}" src="${welcomeScriptUri}"></script>
</body>
</html>`;
}

function isWebviewMessage(value: unknown): value is { type: string } {
  return typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string';
}

class WorkflowViewProvider implements vscode.WebviewViewProvider {
  private webviewView: vscode.WebviewView | undefined;
  private dependencyState: DependencyUiState = { phase: 'checking', message: '正在检查工作区依赖…' };

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly openWelcome: () => void,
    private readonly installDependencies: () => void
  ) {}

  setDependencyState(state: DependencyUiState): void {
    this.dependencyState = state;
    void this.webviewView?.webview.postMessage({ type: 'dependencyState', state });
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.webviewView = webviewView;
    webviewView.onDidDispose(() => {
      if (this.webviewView === webviewView) this.webviewView = undefined;
    });

    const webview = webviewView.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media', 'webview')]
    };

    const assets = vscode.Uri.joinPath(this.extensionUri, 'media', 'webview');
    const stylesUri = webview.asWebviewUri(vscode.Uri.joinPath(assets, 'styles.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(assets, 'main.js'));
    const nonce = randomBytes(16).toString('base64');
    const htmlUri = vscode.Uri.joinPath(assets, 'index.html');

    webview.onDidReceiveMessage((message: unknown) => {
      if (!isWebviewMessage(message)) return;
      if (message.type === 'openWelcome') this.openWelcome();
      if (message.type === 'installDependencies' && this.dependencyState.phase !== 'installing') {
        this.installDependencies();
      }
      if (message.type === 'webviewReady') {
        void webview.postMessage({ type: 'dependencyState', state: this.dependencyState });
      }
    });

    vscode.workspace.fs.readFile(htmlUri).then(
      (content) => {
        webview.html = new TextDecoder().decode(content)
          .replaceAll('{{cspSource}}', webview.cspSource)
          .replaceAll('{{nonce}}', nonce)
          .replace('{{stylesUri}}', stylesUri.toString())
          .replace('{{scriptUri}}', scriptUri.toString());
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        webview.html = `<html><body><p>无法加载 Workflow 视图：${escapeHtml(message)}</p></body></html>`;
      }
    );
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character] ?? character);
}

export function deactivate() {
  welcomePanel?.dispose();
  welcomePanel = undefined;
}

#!/usr/bin/env node
/**
 * 開発用の起動と確認をまとめたスクリプト。Windowsでは同じフォルダの .bat から呼ぶ。
 * ほかのOSでも `node scripts/dev.mjs <command>` で動く。依存パッケージがなくても動くよう、Node標準の機能だけを使う。
 *
 *   setup  環境の確認と依存関係のインストール
 *   mock   モックモード（認証不要。AIと音声認識は台本）で画面と通話サーバーを起動する
 *   local  実際のGemini・Speech-to-Textを使って起動する（Google Cloudの認証が必要）
 *   check  テスト・build・型検査・lintをまとめて実行する
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';
const MIN_NODE = [20, 9];
const WEB_PORT = 3000;
const CALL_PORT = 8080;
const npm = isWindows ? 'npm.cmd' : 'npm';
const npx = isWindows ? 'npx.cmd' : 'npx';

const say = (text = '') => console.log(text);
const heading = (text) => say(`\n=== ${text} ===`);
const ok = (text) => say(`  [OK]   ${text}`);
const warn = (text) => say(`  [注意] ${text}`);
const fail = (text) => say(`  [NG]   ${text}`);

function nodeVersionOk() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
}

/**
 * Windowsの .cmd はシェル経由でしか起動できない。引数はこのファイルに書いた固定の値だけなので、
 * 1つのコマンド文字列にしてシェルへ渡す（引数の配列とシェルを併用するとNodeが警告を出す）。
 */
function shellCommand(command, args) {
  return isWindows ? [[command, ...args].join(' '), [], { shell: true }] : [command, args, {}];
}

/** 外部コマンドを実行し、終了コードを返す。 */
function run(command, args) {
  const [file, fileArgs, extra] = shellCommand(command, args);
  const result = spawnSync(file, fileArgs, { cwd: root, stdio: 'inherit', ...extra });
  return result.status ?? 1;
}

function commandExists(command) {
  return spawnSync(isWindows ? 'where' : 'which', [command], { stdio: 'ignore' }).status === 0;
}

/** ADC（gcloud auth application-default login）の保存先。値は読まない。 */
function adcPath() {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const base = isWindows
    ? path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'gcloud')
    : path.join(os.homedir(), '.config', 'gcloud');
  return path.join(base, 'application_default_credentials.json');
}

function hasEnvFile() {
  return existsSync(path.join(root, '.env'));
}

/** 同じLANの端末から開くためのIPv4アドレス。 */
function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((entry) => entry && entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry.address);
}

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

async function waitForHttp(url, timeoutMs) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(30_000) });
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  return false;
}

function openBrowser(url) {
  if (isWindows) {
    spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
  } else {
    spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase());
    });
  });
}

// ---------------------------------------------------------------------------

async function setup() {
  heading('EchoBridge のセットアップ');
  if (!nodeVersionOk()) {
    fail(`Node.js ${process.versions.node} は古すぎます。${MIN_NODE.join('.')} 以上（推奨: 24 LTS）を https://nodejs.org/ja から入れてください。`);
    return 1;
  }
  ok(`Node.js ${process.versions.node}`);

  heading('依存パッケージのインストール（npm ci）');
  if (run(npm, ['ci', '--no-audit', '--no-fund']) !== 0) {
    fail('npm ci に失敗しました。開発サーバーを起動していたら止めてから、もう一度実行してください。');
    return 1;
  }
  ok('依存パッケージをインストールしました');

  heading('実際のAIを使うための準備（モックモードだけなら不要）');
  reportCloudReadiness();
  say('\n次の手順:');
  say('  - 認証なしで画面を確かめる: start-mock.bat');
  say('  - 実際のGemini・Speech-to-Textで確かめる: start-local.bat（上の準備が必要）');
  say('  - 詳しい手順: docs/TESTING.md');
  return 0;
}

/** 実APIで起動できるかを表示し、足りなければ手順を案内する。秘密の値は読まない。 */
function reportCloudReadiness() {
  let ready = true;
  if (commandExists('gcloud')) {
    ok('gcloud CLI が見つかりました');
  } else {
    warn('gcloud CLI が見つかりません。https://cloud.google.com/sdk/docs/install から入れてください');
  }
  if (existsSync(adcPath())) {
    ok('Google Cloud のアプリケーションのデフォルト認証情報（ADC）が見つかりました');
  } else {
    ready = false;
    warn('ADC が見つかりません。次の2つを実行してください（プロジェクトIDはチームで共有しているもの）:');
    say('         gcloud auth application-default login');
    say('         gcloud auth application-default set-quota-project <プロジェクトID>');
  }
  if (hasEnvFile()) {
    ok('.env が見つかりました（中身はこのスクリプトでは読みません）');
  } else {
    ready = false;
    warn('.env がありません。リポジトリ直下に .env を作り、次の3行を書いてください（コミットしない）:');
    say('         GOOGLE_GENAI_USE_VERTEXAI=true');
    say('         GOOGLE_CLOUD_PROJECT=<プロジェクトID>');
    say('         GOOGLE_CLOUD_LOCATION=global');
  }
  return ready;
}

function ensureDependencies() {
  if (existsSync(path.join(root, 'node_modules', 'next'))) return true;
  fail('依存パッケージが入っていません。先に setup.bat（または node scripts/dev.mjs setup）を実行してください。');
  return false;
}

/** 子プロセスの出力に名前を付けて表示する。 */
function startChild(name, command, args, env) {
  const [file, fileArgs, extra] = shellCommand(command, args);
  const child = spawn(file, fileArgs, {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    ...extra,
  });
  const relay = (stream, target) => {
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';
      lines.forEach((line) => target.write(`[${name}] ${line}\n`));
    });
  };
  relay(child.stdout, process.stdout);
  relay(child.stderr, process.stderr);
  return child;
}

function stopChildren(children) {
  for (const child of children) {
    if (child.exitCode !== null || child.pid === undefined) continue;
    if (isWindows) {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
  }
}

async function startServers(mode) {
  if (!ensureDependencies()) return 1;
  for (const port of [WEB_PORT, CALL_PORT]) {
    if (await portInUse(port)) {
      fail(`ポート ${port} はすでに使われています。前に起動したウィンドウを閉じてから、もう一度実行してください。`);
      return 1;
    }
  }

  const lan = lanAddresses();
  const webOrigins = ['localhost', '127.0.0.1', ...lan].map((host) => `http://${host}:${WEB_PORT}`);
  const env = {
    // 同じLANの端末から本人の画面を開けるようにする。開発時だけ使われる。
    ALLOWED_ORIGINS: webOrigins.join(','),
    EB_ALLOWED_DEV_ORIGINS: lan.join(','),
    PORT: String(CALL_PORT),
  };

  const callServer =
    mode === 'mock'
      ? startChild('call', npx, ['tsx', 'scripts/mock-server.ts'], env)
      : startChild('call', npx, ['tsx', 'server/index.ts'], env);
  const web = startChild('web', npx, ['next', 'dev', '--port', String(WEB_PORT)], env);
  const children = [callServer, web];

  let stopping = false;
  const shutdown = () => {
    stopping = true;
    stopChildren(children);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  children.forEach((child) =>
    child.on('exit', () => {
      if (stopping) return;
      // Ctrl+C はサーバーにも届くので、こちらより先に止まることがある。
      warn('サーバーが止まりました。Ctrl+C で止めた場合は問題ありません。それ以外なら上のログを確認してください。');
      stopping = true;
      stopChildren(children);
      process.exit(1);
    }),
  );

  const url = `http://localhost:${WEB_PORT}`;
  say(`\n画面を準備しています（初回は1分ほどかかります）: ${url}`);
  if (await waitForHttp(url, 180_000)) {
    heading(mode === 'mock' ? 'モックモードで起動しました（開発用・AIではありません）' : '実APIモードで起動しました');
    say(`  本人の画面:   ${url}/`);
    say(`  相手の画面:   本人の画面で発信すると表示される招待リンクを、別のウィンドウで開く`);
    if (lan.length > 0) {
      say(`  同じLANの別の端末から本人の画面を開く: ${lan.map((host) => `http://${host}:${WEB_PORT}/`).join('  ')}`);
      say('  （相手の画面はマイクを使うので、この端末の localhost で開いてください。httpのLANアドレスではマイクを使えません）');
    }
    if (mode === 'mock') {
      say(`  異常系の切り替え: http://localhost:${CALL_PORT}/__mock/ai?mode=fail（ok / fail / slow）`);
    }
    say('\n止めるときは、このウィンドウで Ctrl+C を押してください。');
    // EB_NO_BROWSER=1 なら開かない（自動テストやリモートの端末で使う）。
    if (process.env.EB_NO_BROWSER !== '1') openBrowser(`${url}/`);
  } else {
    warn('画面の準備が時間内に終わりませんでした。上のログを確認してください。');
  }
  return new Promise(() => {});
}

async function local() {
  heading('実APIモードの確認');
  if (!reportCloudReadiness()) {
    say('\n実際のAIを使う準備ができていません。上の手順を済ませるか、モックモードで起動できます。');
    const answer = await ask('モックモード（開発用・AIなし）で起動しますか？ [y/N]: ');
    return answer === 'y' || answer === 'yes' ? startServers('mock') : 1;
  }
  say('\n注意: 実際の Gemini と Speech-to-Text を呼ぶので、Google Cloud の料金がかかります。架空の内容だけで試してください。');
  return startServers('local');
}

async function check() {
  if (!ensureDependencies()) return 1;
  const steps = [
    ['テスト（npm test）', npm, ['test']],
    ['build（npm run build）', npm, ['run', 'build']],
    // 型検査は build が作る next-env.d.ts を使うので、build の後に実行する。
    ['型検査（tsc --noEmit）', npx, ['tsc', '--noEmit']],
    ['lint（npm run lint）', npm, ['run', 'lint']],
  ];
  const results = [];
  for (const [label, command, args] of steps) {
    heading(label);
    results.push([label, run(command, args) === 0]);
  }
  heading('結果');
  results.forEach(([label, passed]) => (passed ? ok(label) : fail(label)));
  return results.every(([, passed]) => passed) ? 0 : 1;
}

const commands = { setup, mock: () => startServers('mock'), local, check };
const command = process.argv[2];
if (!(command in commands)) {
  say('使い方: node scripts/dev.mjs <setup|mock|local|check>');
  process.exit(1);
}
process.exitCode = await commands[command]();

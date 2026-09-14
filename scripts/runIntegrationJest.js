const { spawnSync } = require('child_process');
const path = require('path');

const proxyEnvironmentVariableList = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'SOCKS_PROXY',
  'SOCKS5_PROXY',
  'GIT_HTTP_PROXY',
  'GIT_HTTPS_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'socks_proxy',
  'socks5_proxy',
];

const cleanEnvironment = { ...process.env };

for (const proxyEnvironmentVariableName of proxyEnvironmentVariableList) {
  delete cleanEnvironment[proxyEnvironmentVariableName];
}

const jestArgumentList = [
  '--config',
  'jest.integration.config.js',
  ...process.argv.slice(2),
];

const jestCliPath = path.join(
  path.dirname(require.resolve('jest/package.json')),
  'bin',
  'jest.js'
);

const runResult = spawnSync(process.execPath, [jestCliPath, ...jestArgumentList], {
  stdio: 'inherit',
  env: cleanEnvironment,
  cwd: process.cwd(),
});

if (runResult.error) {
  throw runResult.error;
}

process.exit(runResult.status ?? 1);

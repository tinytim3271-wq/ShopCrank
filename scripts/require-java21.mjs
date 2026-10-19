import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

function parseMajorVersion(output) {
  const match = output.match(/version\s+"(\d+)(?:[._]\d+)?/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

// Gradle builds with JAVA_HOME when it is set, so check that JDK first.
function findJava() {
  const executable = process.platform === 'win32' ? 'java.exe' : 'java';
  const dirs = [
    process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin') : '',
    ...String(process.env.PATH || '').split(delimiter),
  ].filter((dir) => dir && isAbsolute(dir));
  return dirs.map((dir) => join(dir, executable)).find((candidate) => existsSync(candidate)) || null;
}

const javaPath = findJava();
const result = javaPath
  ? spawnSync(javaPath, ['-version'], { encoding: 'utf8' })
  : { error: new Error('java not found') };

if (result.error) {
  console.error('Java is required but was not found in JAVA_HOME or on PATH.');
  console.error('Install Temurin/OpenJDK 21+ and set JAVA_HOME before running Android builds.');
  process.exit(1);
}

const rawOutput = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
const majorVersion = parseMajorVersion(rawOutput);

if (!Number.isInteger(majorVersion)) {
  console.error('Unable to determine Java version from `java -version` output.');
  console.error(rawOutput);
  process.exit(1);
}

if (majorVersion < 21) {
  console.error(`Detected Java ${majorVersion}. Android build requires Java 21 or newer.`);
  if (process.env.JAVA_HOME) {
    console.error(`Current JAVA_HOME: ${process.env.JAVA_HOME}`);
  } else {
    console.error('JAVA_HOME is not set.');
  }
  console.error('Set JAVA_HOME to a JDK 21+ install and re-run the command.');
  process.exit(1);
}

console.log(`Java ${majorVersion} detected (OK for Android build).`);

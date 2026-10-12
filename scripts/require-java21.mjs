import { spawnSync } from 'node:child_process';

function parseMajorVersion(output) {
  const match = output.match(/version\s+"(\d+)(?:[._]\d+)?/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

const result = spawnSync('java', ['-version'], {
  encoding: 'utf8'
});

if (result.error) {
  console.error('Java is required but was not found on PATH.');
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

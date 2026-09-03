import { readdirSync, readFileSync } from 'node:fs';

const sdkPackageJsonUrl = new globalThis.URL(
  '../packages/sdk-typescript/package.json',
  import.meta.url,
);
const sdkSourceDirectoryUrl = new globalThis.URL(
  '../packages/sdk-typescript/src/',
  import.meta.url,
);
const packageJson = JSON.parse(readFileSync(sdkPackageJsonUrl, 'utf8'));

const dependencyFields = ['dependencies', 'optionalDependencies', 'peerDependencies'];
const dependencyViolations = dependencyFields.filter((field) => Object.hasOwn(packageJson, field));

const sourceEntries = readdirSync(sdkSourceDirectoryUrl, { withFileTypes: true });
const sourceFiles = sourceEntries.filter((entry) => entry.isFile() && entry.name.endsWith('.ts'));
const sourceViolations = [];

if (dependencyViolations.length > 0) {
  sourceViolations.push(`dependency fields present: ${dependencyViolations.join(', ')}`);
}

if (sourceEntries.some((entry) => !entry.isFile())) {
  sourceViolations.push('SDK source must remain a flat, explicitly audited directory');
}

if (sourceFiles.length === 0) {
  sourceViolations.push('SDK source contains no TypeScript files');
}

if (sourceFiles.some((entry) => entry.name === 'mapper.ts')) {
  sourceViolations.push('server mapper remains in SDK source');
}

for (const sourceFile of sourceFiles) {
  const source = readFileSync(new globalThis.URL(sourceFile.name, sdkSourceDirectoryUrl), 'utf8');
  if (/['"]@booking-engine\/[^'"]+['"]/u.test(source)) {
    sourceViolations.push(`workspace import present in ${sourceFile.name}`);
  }
}

if (sourceViolations.length > 0) {
  throw new Error(`Public contract boundary check failed:\n- ${sourceViolations.join('\n- ')}`);
}

globalThis.console.log(
  `Public contract boundary check passed (${sourceFiles.length} SDK source file(s)).`,
);

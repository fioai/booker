/* global URL */
import { isIP } from 'node:net';

const ENVIRONMENTS = new Set(['local', 'test', 'staging', 'production']);

export const DEPLOYMENT_IDENTITY_KEYS = Object.freeze([
  'BOOKING_ENGINE_ENV',
  'DATABASE_URL',
  'DATABASE_SCHEMA',
  'HOST',
  'PORT',
  'BOOKING_ENGINE_ORGANIZATION_ID',
  'BOOKING_ENGINE_PROPERTY_ID',
  'ADMIN_ORIGIN',
  'SECURE_COOKIES',
  'BOOKING_ENGINE_SAMPLE_DATA',
  'BOOKING_ENGINE_SAMPLE_PASSWORD',
]);
const IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]*$/u;
const APP_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const PORT_MIN = 1;
const PORT_MAX = 65_535;
const PASSWORD_MARKER_PATTERN = /(?:replace_me|local-only-placeholder|example\.test)/iu;
const APPROVED_TLS_PARAMETER = 'sslmode';
const APPROVED_TLS_MODE = 'verify-full';

function isDeploymentEnvironment(environment) {
  return environment === 'production' || environment === 'staging';
}

function isLoopbackDatabaseHost(hostname) {
  const normalized = hostname.toLowerCase();
  if (
    normalized === 'localhost' ||
    normalized === 'localhost.' ||
    normalized.endsWith('.localhost')
  ) {
    return true;
  }

  const literal =
    normalized.startsWith('[') && normalized.endsWith(']') ? normalized.slice(1, -1) : normalized;
  if (literal === '0' || literal === '0.0.0.0' || literal === '::' || literal === '::1') {
    return true;
  }
  if (literal.startsWith('::ffff:7f')) {
    return true;
  }
  if (isIP(literal) === 4) {
    return literal.startsWith('127.');
  }
  return normalized.startsWith('127.');
}

function hasApprovedTlsMode(url) {
  const parameters = [...url.searchParams.entries()];
  return (
    parameters.length === 1 &&
    parameters[0]?.[0] === APPROVED_TLS_PARAMETER &&
    parameters[0]?.[1] === APPROVED_TLS_MODE
  );
}

export class EnvironmentValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EnvironmentValidationError';
  }
}

function requiredText(input, name) {
  const value = input[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new EnvironmentValidationError(name + ' is required.');
  }
  return value.trim();
}

function boundedInteger(input, name, fallback) {
  const raw = input[name] ?? String(fallback);
  if (!/^\d+$/u.test(raw)) {
    throw new EnvironmentValidationError(name + ' must be a decimal integer.');
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < PORT_MIN || value > PORT_MAX) {
    throw new EnvironmentValidationError(
      name + ' must be between ' + PORT_MIN + ' and ' + PORT_MAX + '.',
    );
  }
  return value;
}

function booleanValue(input, name, fallback) {
  const raw = input[name];
  if (raw === undefined) {
    return fallback;
  }
  if (raw === 'true' || raw === '1') {
    return true;
  }
  if (raw === 'false' || raw === '0') {
    return false;
  }
  throw new EnvironmentValidationError(name + ' must be true or false.');
}

function identifier(input, name) {
  const value = requiredText(input, name);
  if (!APP_IDENTIFIER_PATTERN.test(value)) {
    throw new EnvironmentValidationError(name + ' must be a bounded application identifier.');
  }
  return value;
}

export function validateDatabaseUrl(value, environment = 'local') {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new EnvironmentValidationError('DATABASE_URL is required.');
  }
  let url;
  let username;
  let password;
  try {
    url = new URL(value);
    username = decodeURIComponent(url.username);
    password = decodeURIComponent(url.password);
  } catch {
    throw new EnvironmentValidationError('DATABASE_URL must be a valid PostgreSQL URL.');
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new EnvironmentValidationError(
      'DATABASE_URL must use the postgres or postgresql scheme.',
    );
  }
  if (url.hostname.length === 0 || username.length === 0) {
    throw new EnvironmentValidationError('DATABASE_URL must include a database host and user.');
  }

  const deployment = isDeploymentEnvironment(environment);
  if (deployment && password.length === 0) {
    throw new EnvironmentValidationError(
      'DATABASE_URL must include a non-empty password in staging or production.',
    );
  }
  if (
    deployment &&
    (PASSWORD_MARKER_PATTERN.test(value) ||
      PASSWORD_MARKER_PATTERN.test(username) ||
      PASSWORD_MARKER_PATTERN.test(password))
  ) {
    throw new EnvironmentValidationError(
      'DATABASE_URL must not contain placeholder credentials in staging or production.',
    );
  }
  if (deployment && isLoopbackDatabaseHost(url.hostname)) {
    throw new EnvironmentValidationError(
      'DATABASE_URL must use a non-loopback host in staging or production.',
    );
  }

  const parameters = [...url.searchParams.entries()];
  if (parameters.some(([name]) => name !== APPROVED_TLS_PARAMETER)) {
    throw new EnvironmentValidationError(
      'DATABASE_URL query parameters must be limited to sslmode=verify-full.',
    );
  }
  if (parameters.some(([name]) => name === APPROVED_TLS_PARAMETER) && !hasApprovedTlsMode(url)) {
    throw new EnvironmentValidationError(
      'DATABASE_URL must use sslmode=verify-full for certificate-verified PostgreSQL TLS.',
    );
  }
  if (deployment && !hasApprovedTlsMode(url)) {
    throw new EnvironmentValidationError(
      'DATABASE_URL must use sslmode=verify-full for certificate-verified PostgreSQL TLS in staging or production.',
    );
  }
  return url.toString();
}

function origin(input, environment) {
  const raw = input.ADMIN_ORIGIN;
  if (raw === undefined || raw.trim().length === 0) {
    if (environment === 'production' || environment === 'staging') {
      throw new EnvironmentValidationError(
        'ADMIN_ORIGIN must be an HTTPS origin in staging or production.',
      );
    }
    return undefined;
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new EnvironmentValidationError('ADMIN_ORIGIN must be an exact HTTP(S) origin.');
  }
  if (
    (url.protocol !== 'http:' && url.protocol !== 'https:') ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new EnvironmentValidationError('ADMIN_ORIGIN must be an exact HTTP(S) origin.');
  }
  if ((environment === 'production' || environment === 'staging') && url.protocol !== 'https:') {
    throw new EnvironmentValidationError('ADMIN_ORIGIN must use HTTPS in staging or production.');
  }
  return url.origin;
}

export function validateEnvironment(input, options = {}) {
  const environment = requiredText(input, 'BOOKING_ENGINE_ENV').toLowerCase();
  if (!ENVIRONMENTS.has(environment)) {
    throw new EnvironmentValidationError(
      'BOOKING_ENGINE_ENV must be local, test, staging, or production.',
    );
  }
  const sampleData = booleanValue(input, 'BOOKING_ENGINE_SAMPLE_DATA', false);
  if (sampleData && environment !== 'local' && environment !== 'test') {
    throw new EnvironmentValidationError(
      'sample data is disabled outside local and test environments.',
    );
  }
  if (options.rejectSampleData === true && sampleData) {
    throw new EnvironmentValidationError('sample data is not allowed for this command.');
  }
  const databaseUrl = validateDatabaseUrl(requiredText(input, 'DATABASE_URL'), environment);
  const schema = input.DATABASE_SCHEMA?.trim() || 'public';
  if (!IDENTIFIER_PATTERN.test(schema)) {
    throw new EnvironmentValidationError('DATABASE_SCHEMA must be a lowercase SQL identifier.');
  }
  const host = input.HOST?.trim() || '127.0.0.1';
  if (host.length > 253 || /[\s/]/u.test(host)) {
    throw new EnvironmentValidationError('HOST must be a bounded hostname or IP address.');
  }
  const port = boundedInteger(input, 'PORT', 3000);
  const secureCookies = booleanValue(
    input,
    'SECURE_COOKIES',
    environment === 'production' || environment === 'staging',
  );
  if ((environment === 'production' || environment === 'staging') && !secureCookies) {
    throw new EnvironmentValidationError('SECURE_COOKIES must be true in staging or production.');
  }
  const adminOrigin = origin(input, environment);

  const result = {
    environment,
    databaseUrl,
    schema,
    host,
    port,
    secureCookies,
    adminOrigin,
    sampleData,
  };
  if (options.requireApplicationScope !== false) {
    result.organizationId = identifier(input, 'BOOKING_ENGINE_ORGANIZATION_ID');
    result.propertyId = identifier(input, 'BOOKING_ENGINE_PROPERTY_ID');
  }
  if (sampleData) {
    const samplePassword = requiredText(input, 'BOOKING_ENGINE_SAMPLE_PASSWORD');
    if (samplePassword.length < 12 || samplePassword.length > 256) {
      throw new EnvironmentValidationError(
        'BOOKING_ENGINE_SAMPLE_PASSWORD must be 12 to 256 characters.',
      );
    }
    result.samplePassword = samplePassword;
  }
  return Object.freeze(result);
}

export function validateRuntimeEnvironment(input) {
  return validateEnvironment(input);
}

export function validateMigrationEnvironment(input) {
  return validateEnvironment(input, { requireApplicationScope: false, rejectSampleData: true });
}

export function validateEnvironmentTemplate(text) {
  if (typeof text !== 'string') {
    throw new EnvironmentValidationError('.env.example could not be read.');
  }
  const required = [
    'POSTGRES_DB',
    'POSTGRES_USER',
    'POSTGRES_PASSWORD',
    'DATABASE_URL',
    'DATABASE_SCHEMA',
    'BOOKING_ENGINE_ENV',
    'HOST',
    'PORT',
    'BOOKING_ENGINE_ORGANIZATION_ID',
    'BOOKING_ENGINE_PROPERTY_ID',
    'ADMIN_ORIGIN',
    'SECURE_COOKIES',
  ];
  const missing = required.filter((name) => !new RegExp('^' + name + '=', 'mu').test(text));
  if (missing.length > 0) {
    throw new EnvironmentValidationError('.env.example is missing: ' + missing.join(', ') + '.');
  }
  return Object.freeze({
    keyCount: text.split(/\r?\n/u).filter((line) => /^[A-Z0-9_]+=/.test(line)).length,
  });
}

export function safeEnvironmentSummary(config) {
  return [
    'environment=' + config.environment,
    'schema=' + config.schema,
    'host=' + config.host,
    'port=' + config.port,
    'sampleData=' + String(config.sampleData),
    'secureCookies=' + String(config.secureCookies),
  ].join(' ');
}

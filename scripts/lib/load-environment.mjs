/* global process */

import { loadEnvFile } from 'node:process';

import { DEPLOYMENT_IDENTITY_KEYS } from './environment.mjs';

export { DEPLOYMENT_IDENTITY_KEYS };

export function loadEnvironment(path = '.env') {
  if (DEPLOYMENT_IDENTITY_KEYS.some((name) => process.env[name] !== undefined)) {
    return 'process';
  }

  try {
    loadEnvFile(path);
    return 'file';
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') {
      return 'none';
    }
    throw new Error('Environment file could not be loaded.');
  }
}

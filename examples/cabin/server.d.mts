import type { Server } from 'node:http';

export function createCabinDemoServer(apiPort?: number): Promise<Server>;

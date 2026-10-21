import path from 'node:path';
import os from 'node:os';
import { Service } from '@deepseek-ai/cordis';
import { AgentDbManager } from './manager.js';

export default class AgentDbService extends Service {
  constructor(ctx, config = {}) {
    super(ctx, 'agentDb');
    const stateDirectory = config.stateDirectory ?? path.join(os.homedir(), '.local/state/dsh-agent-db');
    this.manager = new AgentDbManager({ stateDirectory,
      pgxHome: config.pgxHome ?? path.join(stateDirectory, 'pgx') });
    ctx.effect(() => async () => this.manager.close());
  }
  async [Service.init]() { await this.manager.init(); }
}

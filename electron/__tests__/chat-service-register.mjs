// Loader for chat-service.test.mjs: chat-service gets a recording fake in
// place of terminal-manager (no node-pty), everything else resolves normally.
import { register } from 'node:module';
register('./chat-service-loader.mjs', import.meta.url);

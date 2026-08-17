import { EventEmitter } from 'node:events';
import type { RequestEvent } from './types.js';

export type BusEvents = {
  request: (e: RequestEvent) => void;
};

export class EventBus {
  private ee = new EventEmitter();
  on<K extends keyof BusEvents>(event: K, cb: BusEvents[K]): void {
    this.ee.on(event, cb as (...args: unknown[]) => void);
  }
  emit<K extends keyof BusEvents>(event: K, ...args: Parameters<BusEvents[K]>): void {
    this.ee.emit(event, ...args);
  }
}
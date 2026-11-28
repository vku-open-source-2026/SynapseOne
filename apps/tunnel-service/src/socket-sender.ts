// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */

import { once } from 'events';
import WebSocket from 'ws';

export type SocketSender = (message: unknown) => Promise<void>;

export function createSocketSender(socket: WebSocket, maxBufferedAmount: number): SocketSender {
  let queue: Promise<void> = Promise.resolve();
  const waitForCapacity = async (): Promise<void> => {
    if (socket.readyState !== WebSocket.OPEN) throw new Error('Socket is closed');
    if (socket.bufferedAmount <= maxBufferedAmount) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Socket send timed out')), 10000);
      const cleanup = (): void => {
        clearTimeout(timer);
        socket.off('drain', onDrain);
        socket.off('close', onClose);
        socket.off('error', onError);
      };
      const finish = (error?: Error): void => { cleanup(); error ? reject(error) : resolve(); };
      const onDrain = (): void => finish();
      const onClose = (): void => finish(new Error('Socket is closed'));
      const onError = (): void => finish(new Error('Socket send failed'));
      socket.once('drain', onDrain);
      socket.once('close', onClose);
      socket.once('error', onError);
    });
  };
  return (message: unknown): Promise<void> => {
    const raw = JSON.stringify(message);
    const operation = queue.then(async () => {
      await waitForCapacity();
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Socket send timed out')), 10000);
        const finish = (error?: Error): void => { clearTimeout(timer); error ? reject(error) : resolve(); };
        try {
          socket.send(raw, (error) => finish(error ?? undefined));
        } catch {
          finish(new Error('Socket send failed'));
        }
      });
    });
    queue = operation.catch(() => undefined);
    return operation;
  };
}

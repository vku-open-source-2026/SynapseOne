// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
/*
 * Copyright 2026 SynapseOne Contributors
 * Licensed under the Apache License, Version 2.0 (the "License");
 */
'use strict';

const WebSocket = require('ws');

function createSocketSender(socket, maxBufferedAmount = 4 * 1024 * 1024, sendTimeoutMs = 10000) {
  let queue = Promise.resolve();

  const waitForCapacity = async () => {
    if (socket.readyState !== WebSocket.OPEN) throw new Error('Socket is closed');
    if (socket.bufferedAmount <= maxBufferedAmount) return;
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        socket.off('drain', onDrain);
        socket.off('close', onClose);
        socket.off('error', onError);
      };
      const finish = (error) => { cleanup(); error ? reject(error) : resolve(); };
      const onDrain = () => finish();
      const onClose = () => finish(new Error('Socket is closed'));
      const onError = () => finish(new Error('Socket send failed'));
      const timer = setTimeout(() => finish(new Error('Socket send timed out')), sendTimeoutMs);
      socket.once('drain', onDrain);
      socket.once('close', onClose);
      socket.once('error', onError);
    });
  };

  return (message) => {
    const raw = JSON.stringify(message);
    const operation = queue.then(async () => {
      await waitForCapacity();
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error('Socket send timed out')), sendTimeoutMs);
        const finish = (error) => { clearTimeout(timer); error ? reject(error) : resolve(); };
        try {
          socket.send(raw, (error) => finish(error || undefined));
        } catch {
          finish(new Error('Socket send failed'));
        }
      });
    });
    queue = operation.catch(() => undefined);
    return operation;
  };
}

module.exports = { createSocketSender };

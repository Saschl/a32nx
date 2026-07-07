// Copyright (c) 2023-2024 FlyByWire Simulations
// SPDX-License-Identifier: GPL-3.0

export type PayloadInputCommand = {
  name: string;
  value: number;
};

export const sendPayloadInputCommand = (command: PayloadInputCommand): void => {
  if (!Number.isFinite(command.value)) {
    return;
  }

  if (typeof Coherent === 'undefined' || typeof Coherent.call !== 'function') {
    return;
  }

  Coherent.call('COMM_BUS_WASM_CALLBACK', 'FBW_PAYLOAD_INPUT', JSON.stringify(command)).catch(console.error);
};

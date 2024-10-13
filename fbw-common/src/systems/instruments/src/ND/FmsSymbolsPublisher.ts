// Copyright (c) 2021-2024 FlyByWire Simulations
//
// SPDX-License-Identifier: GPL-3.0

import { NdSymbol, NdTraffic, PathVector, VerticalProfile } from '@flybywiresim/fbw-sdk';

export interface FmsSymbolsData {
  symbols: NdSymbol[];
  vectorsActive: PathVector[];
  vectorsDashed: PathVector[];
  vectorsTemporary: PathVector[];
  vectorsMissed: PathVector[];
  vectorsAlternate: PathVector[];
  vectorsSecondary: PathVector[];
  traffic: NdTraffic[];
  verticalProfile: VerticalProfile;
}

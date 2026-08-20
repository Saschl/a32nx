// Copyright (c) 2021-2024 FlyByWire Simulations
//
// SPDX-License-Identifier: GPL-3.0

import { BasePublisher, EventBus } from '@microsoft/msfs-sdk';
import { EfisSide, NdSymbol, NdTraffic, GenericDataListenerRecvSync } from '@flybywiresim/fbw-sdk';

import { PathVector } from '@fmgc/guidance/lnav/PathVector';

export interface FmsSymbolsData {
  symbols: NdSymbol[];
  vectorsActive: PathVector[];
  vectorsActiveEosid: PathVector[];
  vectorsDashed: PathVector[];
  vectorsTemporary: PathVector[];
  vectorsMissed: PathVector[];
  vectorsAlternate: PathVector[];
  vectorsSecondary: PathVector[];
  traffic: NdTraffic[];
}

export class FmsSymbolsPublisher extends BasePublisher<FmsSymbolsData> {
  // One shared listener for all topics: a GenericDataListenerSync per topic would materialize
  // and walk every incoming EB_EVENTS package once per instance, which causes GC spikes with
  // the large symbol/vector packages of long flight plans
  private readonly events = new GenericDataListenerRecvSync();

  constructor(bus: EventBus, side: EfisSide) {
    super(bus);

    this.events.on(`A32NX_EFIS_${side}_SYMBOLS`, (ev, data: NdSymbol[]) => {
      this.publish('symbols', data);
    });

    this.events.on(`A32NX_EFIS_VECTORS_${side}_ACTIVE`, (ev, data: PathVector[]) => {
      this.publish('vectorsActive', data);
    });

    this.events.on(`A32NX_EFIS_VECTORS_${side}_ACTIVE_EOSID`, (ev, data: PathVector[]) => {
      this.publish('vectorsActiveEosid', data);
    });

    this.events.on(`A32NX_EFIS_VECTORS_${side}_DASHED`, (ev, data: PathVector[]) => {
      this.publish('vectorsDashed', data);
    });

    this.events.on(`A32NX_EFIS_VECTORS_${side}_TEMPORARY`, (ev, data: PathVector[]) => {
      this.publish('vectorsTemporary', data);
    });

    this.events.on(`A32NX_EFIS_VECTORS_${side}_MISSED`, (ev, data: PathVector[]) => {
      this.publish('vectorsMissed', data);
    });

    this.events.on(`A32NX_EFIS_VECTORS_${side}_ALTERNATE`, (ev, data: PathVector[]) => {
      this.publish('vectorsAlternate', data);
    });

    this.events.on(`A32NX_EFIS_VECTORS_${side}_SECONDARY`, (ev, data: PathVector[]) => {
      this.publish('vectorsSecondary', data);
    });

    this.events.on(`A32NX_TCAS_${side}_TRAFFIC`, (ev, data: NdTraffic[]) => {
      this.publish('traffic', data);
    });
  }
}

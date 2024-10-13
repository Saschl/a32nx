// Copyright (c) 2021-2024 FlyByWire Simulations
//
// SPDX-License-Identifier: GPL-3.0

import { EventBus } from '@microsoft/msfs-sdk';

import {
  EfisSide,
  GenericDataListenerSync,
  UpdateThrottler,
  VerticalProfile,
  VerticalProfileVector,
} from '@flybywiresim/fbw-sdk';

import { VnavDriver } from '@fmgc/guidance/vnav/VnavDriver';

export class EfisVerticalProfile {
  private throttler = new UpdateThrottler(5_000);

  private lastCreatedProfile: VerticalProfile | null = null;

  private readonly sync = new GenericDataListenerSync();

  constructor(private readonly vnav: VnavDriver) {}

  public update(deltaTime: number): void {
    const forceUpdate = this.lastCreatedProfile === null;
    const canUpdate = this.throttler.canUpdate(deltaTime);

    if (canUpdate < 0 && !forceUpdate) {
      return;
    }

    const verticalProfile = this.createVerticalProfile();

    // FIXME replace with event bus sync
    // FIXME publish on all FMSes
    this.sync.sendEvent(`A32NX_EFIS_L_VERTICAL_PROFILE`, verticalProfile);
    this.sync.sendEvent(`A32NX_EFIS_R_VERTICAL_PROFILE`, verticalProfile);
  }

  private createVerticalProfile(): VerticalProfile | null {
    const profile = this.vnav.mcduProfile;

    if (!profile?.isReadyToDisplay || profile?.checkpoints.length == 0) {
      return null;
    }

    let lastDistance: number | null = null;
    let lastAltitude: number | null = null;
    const vectors: VerticalProfileVector[] = [];

    for (let i = 0; i < profile.checkpoints.length; i++) {
      const checkpoint = profile.checkpoints[i];

      if (lastDistance === null) {
        lastDistance = checkpoint.distanceFromStart;
        lastAltitude = checkpoint.altitude;
      } else {
        vectors.push({
          startDistance: lastDistance,
          startAltitude: lastAltitude,
          endDistance: checkpoint.distanceFromStart,
          endAltitude: checkpoint.altitude,
        });
        lastDistance = null;
        lastAltitude = null;
      }
    }

    return {
      vectors,
      symbols: [],
    };
  }
}

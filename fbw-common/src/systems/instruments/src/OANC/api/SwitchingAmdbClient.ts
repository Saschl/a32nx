// Copyright (c) 2026 FlyByWire Simulations
// SPDX-License-Identifier: GPL-3.0

import {
  AmdbAirportSearchResponse,
  AmdbProjection,
  AmdbResponse,
  FeatureTypeString,
  NXDataStore,
} from '@flybywiresim/fbw-sdk';
import { AmdbDataInterface } from './AmdbDataInterface';
import { MsfsAmdbClient } from './MsfsAmdbClient';
import { NavigraphAmdbClient } from './NavigraphAmdbClient';

/**
 * An {@link AmdbDataInterface} implementation which delegates to either the Navigraph AMDB client
 * or the MSFS facility data client, depending on the CONFIG_OANS_MAP_DATA_SOURCE user setting
 * (changeable in the flyPad EFB settings).
 */
export class SwitchingAmdbClient implements AmdbDataInterface {
  private readonly navigraphClient = new NavigraphAmdbClient();

  // created lazily, so the CommBus listener and facility search session only exist when the MSFS source is used
  private _msfsClient?: MsfsAmdbClient;

  private get msfsClient(): MsfsAmdbClient {
    if (!this._msfsClient) {
      this._msfsClient = new MsfsAmdbClient();
    }
    return this._msfsClient;
  }

  private get activeClient(): AmdbDataInterface {
    return NXDataStore.getSetting('CONFIG_OANS_MAP_DATA_SOURCE').get() === 'MSFS'
      ? this.msfsClient
      : this.navigraphClient;
  }

  public searchForAirports(queryString: string): Promise<AmdbAirportSearchResponse> {
    return this.activeClient.searchForAirports(queryString);
  }

  public getAirportData(
    icao: string,
    includeFeatureTypes?: FeatureTypeString[],
    excludeFeatureTypes?: FeatureTypeString[],
    projection?: AmdbProjection,
  ): Promise<AmdbResponse> {
    return this.activeClient.getAirportData(icao, includeFeatureTypes, excludeFeatureTypes, projection);
  }
}

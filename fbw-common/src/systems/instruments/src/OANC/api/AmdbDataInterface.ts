// Copyright (c) 2023-2024 FlyByWire Simulations
// SPDX-License-Identifier: GPL-3.0

import { AmdbAirportSearchResponse, AmdbProjection, AmdbResponse, FeatureTypeString } from '@flybywiresim/fbw-sdk';

export interface AmdbDataInterface {
  /**
   * Searches for airports available from this data source. An empty query returns all
   * available airports (which may be limited to airports near the aircraft, depending
   * on the data source).
   */
  searchForAirports(queryString: string): Promise<AmdbAirportSearchResponse>;

  getAirportData(
    icao: string,
    includeFeatureTypes?: FeatureTypeString[],
    excludeFeatureTypes?: FeatureTypeString[],
    projection?: AmdbProjection,
  ): Promise<AmdbResponse>;
}

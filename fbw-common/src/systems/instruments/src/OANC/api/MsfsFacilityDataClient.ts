// Copyright (c) 2026 FlyByWire Simulations
// SPDX-License-Identifier: GPL-3.0

/** Raw runway facility data, as serialized by the OansFacilityDataProvider WASM module */
export interface MsfsRawRunway {
  /** runway centre latitude, degrees */
  lat: number;
  /** runway centre longitude, degrees */
  lon: number;
  /** runway elevation, metres */
  alt: number;
  /** true heading of the primary direction, degrees */
  hdg: number;
  /** runway length, metres */
  len: number;
  /** runway width, metres */
  wid: number;
  /** surface type enum */
  surf: number;
  /** primary QFU number (1-36) */
  pnum: number;
  /** primary designator (0 none, 1 L, 2 R, 3 C, 4 W, 5 A, 6 B) */
  pdes: number;
  /** secondary QFU number (1-36) */
  snum: number;
  /** secondary designator */
  sdes: number;
  /** primary displaced threshold length, metres */
  pthr: number;
  /** secondary displaced threshold length, metres */
  sthr: number;
}

/** [type, orientation, biasX (m east of ARP), biasZ (m north of ARP)] */
export type MsfsRawTaxiPoint = [number, number, number, number];

/** [type, name, suffix, number, heading (deg true), radius (m), biasX, biasZ] */
export type MsfsRawTaxiParking = [number, number, number, number, number, number, number, number];

/** [type, width (m), runwayNumber, runwayDesignator, centerLine, start, end, nameIndex] */
export type MsfsRawTaxiPath = [number, number, number, number, number, number, number, number];

/** Raw airport facility data, as serialized by the OansFacilityDataProvider WASM module */
export interface MsfsRawAirport {
  found: boolean;
  icao?: string;
  name?: string;
  lat?: number;
  lon?: number;
  alt?: number;
  magvar?: number;
  runways?: MsfsRawRunway[];
  points?: MsfsRawTaxiPoint[];
  parkings?: MsfsRawTaxiParking[];
  paths?: MsfsRawTaxiPath[];
  names?: string[];
}

export enum MsfsTaxiPathType {
  None = 0,
  Taxi = 1,
  Runway = 2,
  Parking = 3,
  Path = 4,
  Closed = 5,
  Vehicle = 6,
  Road = 7,
  PaintedLine = 8,
}

export enum MsfsTaxiPointType {
  None = 0,
  Normal = 1,
  HoldShort = 2,
  IlsHoldShort = 3,
  HoldShortNoDraw = 4,
  IlsHoldShortNoDraw = 5,
}

interface PendingFacilityRequest {
  chunks: string[];
  received: number;
  resolve: (data: MsfsRawAirport) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const REQUEST_EVENT = 'FBW_OANS_FACILITY_REQUEST';
const REPLY_EVENT = 'FBW_OANS_FACILITY_REPLY';
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * Fetches raw airport facility data (runways + taxi network) from the OansFacilityDataProvider
 * WASM module in the extra-backend via CommBus.
 */
export class MsfsFacilityDataClient {
  private readonly pendingRequests = new Map<number, PendingFacilityRequest>();

  private readonly listener = RegisterViewListener('JS_LISTENER_COMM_BUS', () => {
    this.listener.on(REPLY_EVENT, (data: string) => this.onReply(data));
  });

  /**
   * Requests the airport facility data for the given ICAO from the WASM module.
   * Rejects if the request times out; resolves with found=false for an unknown airport.
   */
  public async fetchAirport(icao: string): Promise<MsfsRawAirport> {
    // the WASM module only processes one request at a time, so retry once in case
    // a concurrent request from another instrument displaced ours
    try {
      return await this.fetchAirportAttempt(icao);
    } catch (e) {
      console.warn(`[OANC] MsfsFacilityDataClient: retrying facility request for ${icao}:`, e);
      return this.fetchAirportAttempt(icao);
    }
  }

  private fetchAirportAttempt(icao: string): Promise<MsfsRawAirport> {
    return new Promise<MsfsRawAirport>((resolve, reject) => {
      // ids only need to be unique across concurrently pending requests of all instruments
      const requestId = Math.floor(Math.random() * 0x7fffffff);

      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`MsfsFacilityDataClient: facility request for ${icao} timed out`));
      }, REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(requestId, { chunks: [], received: 0, resolve, reject, timeout });

      Coherent.call('COMM_BUS_WASM_CALLBACK', REQUEST_EVENT, JSON.stringify({ requestId, icao }));
    });
  }

  private onReply(data: string): void {
    // format: "<requestId>;<chunkIndex>;<chunkCount>;<data>"
    const firstSep = data.indexOf(';');
    const secondSep = data.indexOf(';', firstSep + 1);
    const thirdSep = data.indexOf(';', secondSep + 1);
    if (firstSep === -1 || secondSep === -1 || thirdSep === -1) {
      console.error('[OANC] MsfsFacilityDataClient: malformed facility reply');
      return;
    }

    const requestId = parseInt(data.substring(0, firstSep), 10);
    const chunkIndex = parseInt(data.substring(firstSep + 1, secondSep), 10);
    const chunkCount = parseInt(data.substring(secondSep + 1, thirdSep), 10);

    const request = this.pendingRequests.get(requestId);
    if (!request) {
      // reply for a request of another instrument
      return;
    }

    request.chunks[chunkIndex] = data.substring(thirdSep + 1);
    request.received++;

    if (request.received >= chunkCount) {
      this.pendingRequests.delete(requestId);
      clearTimeout(request.timeout);

      try {
        request.resolve(JSON.parse(request.chunks.join('')) as MsfsRawAirport);
      } catch (e) {
        request.reject(new Error(`MsfsFacilityDataClient: could not parse facility reply: ${e}`));
      }
    }
  }
}

// Copyright (c) 2026 FlyByWire Simulations
// SPDX-License-Identifier: GPL-3.0

import {
  AmdbAirportSearchResponse,
  AmdbFeature,
  AmdbFeatureCollection,
  AmdbProjection,
  AmdbProperties,
  AmdbResponse,
  FeatureType,
  FeatureTypeString,
  OansMapProjection,
} from '@flybywiresim/fbw-sdk';
import {
  AirportFacilityDataFlags,
  EventBus,
  FacilityLoader,
  FacilityRepository,
  FacilitySearchType,
  FacilityType,
  ICAO,
  IcaoValue,
  NearestAirportFilteredSearchSession,
  NearestIcaoSearchSessionDataType,
} from '@microsoft/msfs-sdk';
import { LineString, Point, Polygon, Position } from 'geojson';
import { Coordinates } from 'msfs-geo';
import { AmdbDataInterface } from './AmdbDataInterface';
import {
  MsfsFacilityDataClient,
  MsfsRawAirport,
  MsfsRawRunway,
  MsfsTaxiPathType,
  MsfsTaxiPointType,
} from './MsfsFacilityDataClient';

/** Runway designator enum to letter (RUNWAY_DESIGNATOR facility field) */
const DESIGNATOR_LETTERS = ['', 'L', 'R', 'C', 'W', 'A', 'B'];

/** TAXI_PARKING NAME enum values 2..9 (directional parkings) */
const PARKING_DIRECTION_PREFIXES = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/** TAXI_PARKING types which are not aircraft stands */
const NON_STAND_PARKING_TYPES = [0 /* NONE */, 12 /* FUEL */, 13 /* VEHICLE */];

/** Maximum length of a synthesized runway exit line, in metres */
const EXIT_LINE_MAX_LENGTH = 300;

/** Painted runway designation character height, metres (ICAO Annex 14) */
const MARKING_CHAR_HEIGHT = 9;

/** Painted runway designation stroke width, metres */
const MARKING_STROKE_WIDTH = 1.5;

/**
 * Stroke font for painted runway designations. Each character is a list of polylines in a unit
 * box (x 0..0.6, y 0..1, y up), scaled by MARKING_CHAR_HEIGHT and extruded to pavement polygons.
 */
const MARKING_FONT: Record<string, [number, number][][]> = {
  '0': [
    [
      [0, 0],
      [0, 1],
      [0.6, 1],
      [0.6, 0],
      [0, 0],
    ],
  ],
  '1': [
    [
      [0.3, 0],
      [0.3, 1],
    ],
  ],
  '2': [
    [
      [0, 1],
      [0.6, 1],
      [0.6, 0.5],
      [0, 0.5],
      [0, 0],
      [0.6, 0],
    ],
  ],
  '3': [
    [
      [0, 1],
      [0.6, 1],
      [0.6, 0],
      [0, 0],
    ],
    [
      [0.6, 0.5],
      [0.2, 0.5],
    ],
  ],
  '4': [
    [
      [0, 1],
      [0, 0.5],
      [0.6, 0.5],
    ],
    [
      [0.6, 1],
      [0.6, 0],
    ],
  ],
  '5': [
    [
      [0.6, 1],
      [0, 1],
      [0, 0.5],
      [0.6, 0.5],
      [0.6, 0],
      [0, 0],
    ],
  ],
  '6': [
    [
      [0.6, 1],
      [0, 1],
      [0, 0],
      [0.6, 0],
      [0.6, 0.5],
      [0, 0.5],
    ],
  ],
  '7': [
    [
      [0, 1],
      [0.6, 1],
      [0.3, 0],
    ],
  ],
  '8': [
    [
      [0, 0],
      [0, 1],
      [0.6, 1],
      [0.6, 0],
      [0, 0],
    ],
    [
      [0, 0.5],
      [0.6, 0.5],
    ],
  ],
  '9': [
    [
      [0, 0],
      [0.6, 0],
      [0.6, 1],
      [0, 1],
      [0, 0.5],
      [0.6, 0.5],
    ],
  ],
  L: [
    [
      [0, 1],
      [0, 0],
      [0.6, 0],
    ],
  ],
  R: [
    [
      [0, 0],
      [0, 1],
      [0.6, 1],
      [0.6, 0.5],
      [0, 0.5],
    ],
    [
      [0.3, 0.5],
      [0.6, 0],
    ],
  ],
  C: [
    [
      [0.6, 1],
      [0, 1],
      [0, 0],
      [0.6, 0],
    ],
  ],
  W: [
    [
      [0, 1],
      [0.1, 0],
      [0.3, 0.6],
      [0.5, 0],
      [0.6, 1],
    ],
  ],
  A: [
    [
      [0, 0],
      [0, 1],
      [0.6, 1],
      [0.6, 0],
    ],
    [
      [0, 0.5],
      [0.6, 0.5],
    ],
  ],
  B: [
    [
      [0, 0],
      [0, 1],
      [0.6, 1],
      [0.6, 0],
      [0, 0],
    ],
    [
      [0, 0.5],
      [0.6, 0.5],
    ],
  ],
};

/** Radius around the aircraft used for the empty-query airport search, in metres */
const AIRPORT_SEARCH_RADIUS = 400_000;

/** Maximum number of airports returned by the airport search */
const AIRPORT_SEARCH_MAX_RESULTS = 100;

interface TaxiEdge {
  /** node ids: positive values index taxi points, negative values encode parking index as -(index + 1) */
  a: number;
  b: number;
  type: MsfsTaxiPathType;
  width: number;
  name: string;
  /** runway ident for RUNWAY type paths */
  runwayIdent: string;
}

/**
 * An {@link AmdbDataInterface} implementation which synthesizes AMDB-style GeoJSON features from
 * the simulator's own airport facility data (fetched from the OansFacilityDataProvider WASM module
 * via {@link MsfsFacilityDataClient}).
 *
 * The sim data is a routing graph (taxi path centrelines with widths, parking spots, runway
 * rectangles), not an aerodrome mapping database, so pavement polygons are synthesized by
 * extruding the taxi paths by their width. Aprons, buildings and deicing areas are not available
 * from the sim and are omitted.
 */
export class MsfsAmdbClient implements AmdbDataInterface {
  private readonly facilityDataClient = new MsfsFacilityDataClient();

  private readonly bus = new EventBus();

  private facilityLoader?: FacilityLoader;

  private searchSession?: NearestAirportFilteredSearchSession<NearestIcaoSearchSessionDataType.StringV1>;

  private readonly nearbyAirportIcaos = new Set<string>();

  private cachedIcao?: string;

  private cachedFeatures?: Promise<Map<FeatureTypeString, AmdbFeature[]>>;

  private cachedRawAirport?: Promise<MsfsRawAirport>;

  private nextFeatureId = 1;

  public async searchForAirports(queryString: string): Promise<AmdbAirportSearchResponse> {
    if (!this.facilityLoader) {
      this.facilityLoader = new FacilityLoader(FacilityRepository.getRepository(this.bus));
    }

    const query = queryString.trim().toUpperCase();

    let icaos: IcaoValue[];
    if (query.length > 0) {
      // global ident-prefix search
      icaos = await this.facilityLoader.searchByIdentWithIcaoStructs(
        FacilitySearchType.Airport,
        query,
        AIRPORT_SEARCH_MAX_RESULTS,
      );
    } else {
      // no query: return the airports around the aircraft
      const lat = SimVar.GetSimVarValue('PLANE LATITUDE', 'degree latitude');
      const long = SimVar.GetSimVarValue('PLANE LONGITUDE', 'degree longitude');

      if (!this.searchSession) {
        this.searchSession = await this.facilityLoader.startNearestSearchSession(FacilitySearchType.Airport);
      }

      const diff = await this.searchSession.searchNearest(lat, long, AIRPORT_SEARCH_RADIUS, AIRPORT_SEARCH_MAX_RESULTS);
      for (const icao of diff.added) {
        this.nearbyAirportIcaos.add(icao);
      }
      for (const icao of diff.removed) {
        this.nearbyAirportIcaos.delete(icao);
      }

      icaos = [...this.nearbyAirportIcaos].map((icao) => ICAO.stringV1ToValue(icao));
    }

    const facilities = await Promise.all(
      icaos.map((icao) =>
        this.facilityLoader.getFacility(FacilityType.Airport, icao, AirportFacilityDataFlags.Minimal).catch(() => null),
      ),
    );

    const seenIdents = new Set<string>();

    return facilities
      .filter((fac) => fac !== null)
      .map((fac) => ({
        idarpt: (fac.icaoStruct?.ident ?? ICAO.getIdent(fac.icao)).trim(),
        iata: null,
        name: typeof Utils !== 'undefined' ? Utils.Translate(fac.name) ?? fac.name : fac.name,
        coordinates: { lat: fac.lat, lon: fac.lon },
        elev: 0,
      }))
      .filter((arpt) => {
        // real airport idents are at most 4 characters - longer ones are MSFS-internal pseudo idents
        if (arpt.idarpt.length === 0 || arpt.idarpt.length > 4 || seenIdents.has(arpt.idarpt)) {
          return false;
        }
        seenIdents.add(arpt.idarpt);
        return true;
      })
      .sort((a, b) => a.idarpt.localeCompare(b.idarpt));
  }

  public async getAirportData(
    icao: string,
    includeFeatureTypes?: FeatureTypeString[],
    excludeFeatureTypes?: FeatureTypeString[],
    projection = AmdbProjection.ArpAzeq,
  ): Promise<AmdbResponse> {
    if (this.cachedIcao !== icao || !this.cachedRawAirport) {
      this.cachedIcao = icao;
      this.cachedRawAirport = this.facilityDataClient.fetchAirport(icao);
      this.cachedFeatures = undefined;
    }

    const raw = await this.cachedRawAirport;
    if (!raw.found) {
      this.cachedIcao = undefined;
      this.cachedRawAirport = undefined;
      throw new Error(`[OANC] MsfsAmdbClient: airport ${icao} not found in simulator facility data`);
    }

    if (projection === AmdbProjection.Epsg4326) {
      // only the aerodrome reference point is required in WGS84 (used by the OANC to recover the true ARP position)
      const response: AmdbResponse = {};
      for (const type of includeFeatureTypes ?? [FeatureTypeString.AerodromeReferencePoint]) {
        response[type] = this.emptyCollection();
      }
      const arpCollection = response[FeatureTypeString.AerodromeReferencePoint];
      if (arpCollection) {
        arpCollection.features.push(this.arpFeature(raw, [raw.lon, raw.lat]));
      }
      return response;
    }

    if (!this.cachedFeatures) {
      this.cachedFeatures = Promise.resolve().then(() => this.synthesizeFeatures(raw));
    }
    const featureMap = await this.cachedFeatures;

    const requestedTypes = includeFeatureTypes ?? [...featureMap.keys()];

    const response: AmdbResponse = {};
    for (const type of requestedTypes) {
      if (excludeFeatureTypes?.includes(type)) {
        continue;
      }
      response[type] = {
        type: 'FeatureCollection',
        features: featureMap.get(type) ?? [],
      };
    }

    return response;
  }

  private emptyCollection(): AmdbFeatureCollection {
    return { type: 'FeatureCollection', features: [] };
  }

  private arpFeature(raw: MsfsRawAirport, coordinates: Position): AmdbFeature<Point> {
    return this.feature<Point>(
      { type: 'Point', coordinates },
      {
        feattype: FeatureType.AerodromeReferencePoint,
        name: raw.name,
        ident: raw.icao,
      },
    );
  }

  private feature<G extends Point | LineString | Polygon>(
    geometry: G,
    properties: Omit<AmdbProperties, 'id'>,
  ): AmdbFeature<G> {
    return {
      type: 'Feature',
      geometry,
      properties: { ...properties, id: this.nextFeatureId++ } as AmdbProperties,
    };
  }

  // =============================================================================================
  // Feature synthesis
  // =============================================================================================

  private synthesizeFeatures(raw: MsfsRawAirport): Map<FeatureTypeString, AmdbFeature[]> {
    const map = new Map<FeatureTypeString, AmdbFeature[]>();
    const push = (type: FeatureTypeString, feature: AmdbFeature) => {
      let features = map.get(type);
      if (!features) {
        features = [];
        map.set(type, features);
      }
      features.push(feature);
    };

    // make sure all synthesized types exist, even when empty
    for (const type of [
      FeatureTypeString.RunwayElement,
      FeatureTypeString.RunwayDisplacedArea,
      FeatureTypeString.RunwayMarking,
      FeatureTypeString.BlastPad,
      FeatureTypeString.Stopway,
      FeatureTypeString.RunwayThreshold,
      FeatureTypeString.PaintedCenterline,
      FeatureTypeString.TaxiwayElement,
      FeatureTypeString.TaxiwayGuidanceLine,
      FeatureTypeString.TaxiwayHoldingPosition,
      FeatureTypeString.RunwayExitLine,
      FeatureTypeString.StandGuidanceLine,
      FeatureTypeString.ParkingStandLocation,
      FeatureTypeString.ParkingStandArea,
      FeatureTypeString.ServiceRoad,
      FeatureTypeString.AerodromeReferencePoint,
      FeatureTypeString.DeicingArea,
      FeatureTypeString.ApronElement,
      FeatureTypeString.VerticalPolygonalStructure,
    ]) {
      map.set(type, []);
    }

    push(FeatureTypeString.AerodromeReferencePoint, this.arpFeature(raw, [0, 0]));

    const arp: Coordinates = { lat: raw.lat, long: raw.lon };
    const magvar = raw.magvar ?? 0;

    for (const runway of raw.runways ?? []) {
      this.synthesizeRunway(runway, arp, magvar, push);
    }

    this.synthesizeTaxiNetwork(raw, push);

    console.log(
      `[OANC] MsfsAmdbClient: synthesized features for ${raw.icao}:`,
      [...map.entries()]
        .filter(([, features]) => features.length > 0)
        .map(([type, features]) => `${type}=${features.length}`)
        .join(' '),
    );

    return map;
  }

  private synthesizeRunway(
    runway: MsfsRawRunway,
    arp: Coordinates,
    magvar: number,
    push: (type: FeatureTypeString, feature: AmdbFeature) => void,
  ): void {
    const center = OansMapProjection.globalToAirportCoordinates(arp, { lat: runway.lat, long: runway.lon }, [0, 0]);

    const hdgRad = runway.hdg * (Math.PI / 180);
    const dir = [Math.sin(hdgRad), Math.cos(hdgRad)];
    const perp = [Math.cos(hdgRad), -Math.sin(hdgRad)];

    const halfLen = runway.len / 2;

    const along = (base: Position, distance: number): Position => [
      base[0] + dir[0] * distance,
      base[1] + dir[1] * distance,
    ];
    const across = (base: Position, distance: number): Position => [
      base[0] + perp[0] * distance,
      base[1] + perp[1] * distance,
    ];

    // the primary end is where the takeoff run in the primary direction begins
    const primaryEnd = along(center, -halfLen);
    const secondaryEnd = along(center, halfLen);

    const primaryIdent = MsfsAmdbClient.runwayEndIdent(runway.pnum, runway.pdes);
    const secondaryIdent = MsfsAmdbClient.runwayEndIdent(runway.snum, runway.sdes);
    const idrwy = `${primaryIdent}.${secondaryIdent}`;

    const rectangle = (from: Position, to: Position, width = runway.wid): Polygon => {
      const halfW = width / 2;
      return {
        type: 'Polygon',
        coordinates: [
          [across(from, halfW), across(to, halfW), across(to, -halfW), across(from, -halfW), across(from, halfW)],
        ],
      };
    };

    const pthr = MsfsAmdbClient.pavementLength(runway.pthr);
    const sthr = MsfsAmdbClient.pavementLength(runway.sthr);

    console.log(
      `[OANC] MsfsAmdbClient: runway ${idrwy}: len=${runway.len} wid=${runway.wid}`,
      `pthr=${JSON.stringify(runway.pthr)} pbp=${JSON.stringify(runway.pbp)} pov=${JSON.stringify(runway.pov)}`,
      `sthr=${JSON.stringify(runway.sthr)} sbp=${JSON.stringify(runway.sbp)} sov=${JSON.stringify(runway.sov)}`,
      `pcl=${runway.pcl} scl=${runway.scl}`,
    );

    push(
      FeatureTypeString.RunwayElement,
      this.feature(rectangle(primaryEnd, secondaryEnd), {
        feattype: FeatureType.RunwayElement,
        idrwy,
      }),
    );

    push(
      FeatureTypeString.PaintedCenterline,
      this.feature<LineString>(
        { type: 'LineString', coordinates: [primaryEnd, secondaryEnd] },
        { feattype: FeatureType.PaintedCenterline, idrwy },
      ),
    );

    const thresholds: [Position, string, number, number][] = [
      [along(primaryEnd, pthr), primaryIdent, runway.hdg, pthr],
      [along(secondaryEnd, -sthr), secondaryIdent, MsfsAmdbClient.normalizeHeading(runway.hdg + 180), sthr],
    ];

    for (const [position, idthr, brngtrue, displaced] of thresholds) {
      push(
        FeatureTypeString.RunwayThreshold,
        this.feature<Point>(
          { type: 'Point', coordinates: position },
          {
            feattype: FeatureType.RunwayThreshold,
            idthr,
            idrwy,
            brngtrue,
            brngmag: MsfsAmdbClient.normalizeHeading(brngtrue - magvar),
            lda: runway.len - displaced,
            tora: runway.len,
          },
        ),
      );
    }

    if (pthr > 0) {
      push(
        FeatureTypeString.RunwayDisplacedArea,
        this.feature(
          rectangle(primaryEnd, along(primaryEnd, pthr), MsfsAmdbClient.pavementWidth(runway.pthr, runway.wid)),
          { feattype: FeatureType.RunwayDisplacedArea, idrwy },
        ),
      );
    }
    if (sthr > 0) {
      push(
        FeatureTypeString.RunwayDisplacedArea,
        this.feature(
          rectangle(along(secondaryEnd, -sthr), secondaryEnd, MsfsAmdbClient.pavementWidth(runway.sthr, runway.wid)),
          { feattype: FeatureType.RunwayDisplacedArea, idrwy },
        ),
      );
    }

    // blastpads and overruns (stopways) extend beyond the runway pavement ends
    const pbp = MsfsAmdbClient.pavementLength(runway.pbp);
    const sbp = MsfsAmdbClient.pavementLength(runway.sbp);
    const pov = MsfsAmdbClient.pavementLength(runway.pov);
    const sov = MsfsAmdbClient.pavementLength(runway.sov);
    const overrunAreas: [number, number, Position, Position, FeatureTypeString, FeatureType][] = [
      [
        pbp,
        MsfsAmdbClient.pavementWidth(runway.pbp, runway.wid),
        along(primaryEnd, -pbp),
        primaryEnd,
        FeatureTypeString.BlastPad,
        FeatureType.BlastPad,
      ],
      [
        sbp,
        MsfsAmdbClient.pavementWidth(runway.sbp, runway.wid),
        secondaryEnd,
        along(secondaryEnd, sbp),
        FeatureTypeString.BlastPad,
        FeatureType.BlastPad,
      ],
      [
        pov,
        MsfsAmdbClient.pavementWidth(runway.pov, runway.wid),
        along(primaryEnd, -pov),
        primaryEnd,
        FeatureTypeString.Stopway,
        FeatureType.Stopway,
      ],
      [
        sov,
        MsfsAmdbClient.pavementWidth(runway.sov, runway.wid),
        secondaryEnd,
        along(secondaryEnd, sov),
        FeatureTypeString.Stopway,
        FeatureType.Stopway,
      ],
    ];
    for (const [length, width, from, to, typeString, feattype] of overrunAreas) {
      if (length > 0) {
        push(typeString, this.feature(rectangle(from, to, width), { feattype, idrwy }));
      }
    }

    this.synthesizeRunwayMarkings(runway, primaryEnd, dir, perp, primaryIdent, secondaryIdent, idrwy, pthr, sthr, push);
  }

  /**
   * Synthesizes the painted runway markings (threshold stripes, designation characters and
   * centreline dashes) as AMDB RunwayMarking pavement polygons. Dimensions follow ICAO Annex 14.
   */
  private synthesizeRunwayMarkings(
    runway: MsfsRawRunway,
    primaryEnd: Position,
    dir: number[],
    perp: number[],
    primaryIdent: string,
    secondaryIdent: string,
    idrwy: string,
    pthr: number,
    sthr: number,
    push: (type: FeatureTypeString, feature: AmdbFeature) => void,
  ): void {
    const pushMarking = (coordinates: Position[], width: number) =>
      push(
        FeatureTypeString.RunwayMarking,
        this.feature(MsfsAmdbClient.extrudePolyline(coordinates, [width]), {
          feattype: FeatureType.RunwayMarking,
          idrwy,
        }),
      );

    // both runway ends: threshold position, direction of travel, and "reading right" vector for text
    const ends: {
      threshold: Position;
      ident: string;
      dir: number[];
      right: number[];
      closed: boolean;
      displaced: number;
      overrun: number;
    }[] = [
      {
        threshold: [primaryEnd[0] + dir[0] * pthr, primaryEnd[1] + dir[1] * pthr],
        ident: primaryIdent,
        dir,
        right: perp,
        closed: (runway.pcl ?? 0) !== 0,
        displaced: pthr,
        overrun: Math.max(MsfsAmdbClient.pavementLength(runway.pbp), MsfsAmdbClient.pavementLength(runway.pov)),
      },
      {
        threshold: [primaryEnd[0] + dir[0] * (runway.len - sthr), primaryEnd[1] + dir[1] * (runway.len - sthr)],
        ident: secondaryIdent,
        dir: [-dir[0], -dir[1]],
        right: [-perp[0], -perp[1]],
        closed: (runway.scl ?? 0) !== 0,
        displaced: sthr,
        overrun: Math.max(MsfsAmdbClient.pavementLength(runway.sbp), MsfsAmdbClient.pavementLength(runway.sov)),
      },
    ];

    for (const end of ends) {
      // closed runway ends carry no threshold/designation markings
      if (end.closed) {
        continue;
      }
      const at = (alongDist: number, acrossDist: number): Position => [
        end.threshold[0] + end.dir[0] * alongDist + end.right[0] * acrossDist,
        end.threshold[1] + end.dir[1] * alongDist + end.right[1] * acrossDist,
      ];

      // threshold stripes ("piano keys"), 6 m to 36 m past the threshold; stripe count per ICAO by width
      const stripeCount =
        runway.wid >= 55 ? 16 : runway.wid >= 40 ? 12 : runway.wid >= 27 ? 8 : runway.wid >= 20 ? 6 : 4;
      const usableWidth = runway.wid * 0.75;
      const stripePitch = usableWidth / stripeCount;

      // displaced threshold: transverse bar at the threshold and centreline arrows pointing towards it
      if (end.displaced > 0) {
        pushMarking([at(-1.5, -usableWidth / 2), at(-1.5, usableWidth / 2)], 1.8);

        for (let tip = -end.displaced + 30; tip <= -10; tip += 30) {
          pushMarking([at(tip - 20, 0), at(tip - 6, 0)], 0.9);
          pushMarking([at(tip - 8, -3), at(tip, 0)], 1.2);
          pushMarking([at(tip - 8, 3), at(tip, 0)], 1.2);
        }
      }

      // blastpad/stopway: chevrons across the pavement, pointing towards the runway
      if (end.overrun > 0) {
        const chevronHalfWidth = runway.wid * 0.35;
        for (let tip = -end.displaced - end.overrun + 25; tip <= -end.displaced - 5; tip += 30) {
          pushMarking([at(tip - 15, -chevronHalfWidth), at(tip, 0)], 1.5);
          pushMarking([at(tip - 15, chevronHalfWidth), at(tip, 0)], 1.5);
        }
      }
      for (let i = 0; i < stripeCount; i++) {
        const offset = -usableWidth / 2 + stripePitch * (i + 0.5);
        pushMarking([at(6, offset), at(36, offset)], 1.8);
      }

      // designation: parallel-runway letter between the threshold marking and the numerals (ICAO)
      const numerals = end.ident.slice(0, 2);
      const letter = end.ident.slice(2);

      const drawCharacterRow = (text: string, startDist: number) => {
        const charWidth = 0.6 * MARKING_CHAR_HEIGHT;
        const charGap = 2;
        let x = -(text.length * charWidth + (text.length - 1) * charGap) / 2;
        for (const char of text) {
          for (const stroke of MARKING_FONT[char] ?? []) {
            pushMarking(
              stroke.map(([gx, gy]) => at(startDist + gy * MARKING_CHAR_HEIGHT, x + gx * MARKING_CHAR_HEIGHT)),
              MARKING_STROKE_WIDTH,
            );
          }
          x += charWidth + charGap;
        }
      };

      if (letter.length > 0) {
        drawCharacterRow(letter, 42);
      }
      drawCharacterRow(numerals, 57);
    }

    // centreline dashes (30 m dash / 20 m gap) between the designation markings of both ends
    const dashStart = pthr + 75;
    const dashEnd = runway.len - sthr - 75;
    for (let s = dashStart; s < dashEnd; s += 50) {
      const e = Math.min(s + 30, dashEnd);
      pushMarking(
        [
          [primaryEnd[0] + dir[0] * s, primaryEnd[1] + dir[1] * s],
          [primaryEnd[0] + dir[0] * e, primaryEnd[1] + dir[1] * e],
        ],
        0.9,
      );
    }
  }

  private synthesizeTaxiNetwork(
    raw: MsfsRawAirport,
    push: (type: FeatureTypeString, feature: AmdbFeature) => void,
  ): void {
    const points = raw.points ?? [];
    const parkings = raw.parkings ?? [];
    const names = raw.names ?? [];

    const nodePosition = (node: number): Position => {
      if (node < 0) {
        const parking = parkings[-node - 1];
        return [parking[6], parking[7]];
      }
      const point = points[node];
      return [point[2], point[3]];
    };

    const edges: TaxiEdge[] = [];
    for (const path of raw.paths ?? []) {
      const [type, width, runwayNumber, runwayDesignator, , start, end, nameIndex] = path;

      const endIsParking = type === MsfsTaxiPathType.Parking;
      if (
        start < 0 ||
        start >= points.length ||
        end < 0 ||
        (endIsParking ? end >= parkings.length : end >= points.length)
      ) {
        continue;
      }

      edges.push({
        a: start,
        b: endIsParking ? -(end + 1) : end,
        type,
        width: width > 0 ? width : 15,
        name: type === MsfsTaxiPathType.Runway ? '' : (names[nameIndex] ?? '').trim(),
        runwayIdent:
          type === MsfsTaxiPathType.Runway ? MsfsAmdbClient.runwayEndIdent(runwayNumber, runwayDesignator) : '',
      });
    }

    const taxiEdges = edges.filter((e) => e.type === MsfsTaxiPathType.Taxi || e.type === MsfsTaxiPathType.Path);
    const roadEdges = edges.filter((e) => e.type === MsfsTaxiPathType.Vehicle || e.type === MsfsTaxiPathType.Road);
    const parkingEdges = edges.filter((e) => e.type === MsfsTaxiPathType.Parking);

    const runwayNodes = new Set<number>();
    for (const edge of edges) {
      if (edge.type === MsfsTaxiPathType.Runway) {
        runwayNodes.add(edge.a);
        runwayNodes.add(edge.b);
      }
    }

    // taxiways: chain per name, then emit guidance line + extruded pavement per chain
    const taxiEdgesByName = new Map<string, TaxiEdge[]>();
    for (const edge of taxiEdges) {
      const group = taxiEdgesByName.get(edge.name);
      if (group) {
        group.push(edge);
      } else {
        taxiEdgesByName.set(edge.name, [edge]);
      }
    }

    for (const [name, group] of taxiEdgesByName) {
      for (const chain of MsfsAmdbClient.chainEdges(group)) {
        const coordinates = chain.nodes.map(nodePosition);
        const midpoint: Point = { type: 'Point', coordinates: coordinates[Math.floor(coordinates.length / 2)] };

        push(
          FeatureTypeString.TaxiwayElement,
          // scenery-authored per-segment widths are often noisy, so the whole chain is extruded
          // at its median width to avoid visible steps/tapers along a taxiway
          this.feature(MsfsAmdbClient.extrudePolyline(coordinates, [MsfsAmdbClient.medianWidth(chain.widths)]), {
            feattype: FeatureType.TaxiwayElement,
            idlin: name.length > 0 ? name : undefined,
          }),
        );

        push(
          FeatureTypeString.TaxiwayGuidanceLine,
          this.feature<LineString>(
            { type: 'LineString', coordinates },
            {
              feattype: FeatureType.TaxiwayGuidanceLine,
              idlin: name.length > 0 ? name : undefined,
              midpoint,
            },
          ),
        );
      }
    }

    // service roads: chain everything connected, regardless of name
    for (const chain of MsfsAmdbClient.chainEdges(roadEdges)) {
      const coordinates = chain.nodes.map(nodePosition);
      push(
        FeatureTypeString.ServiceRoad,
        this.feature(MsfsAmdbClient.extrudePolyline(coordinates, [MsfsAmdbClient.medianWidth(chain.widths)]), {
          feattype: FeatureType.ServiceRoad,
        }),
      );
    }

    // stand guidance (lead-in) lines
    for (const chain of MsfsAmdbClient.chainEdges(parkingEdges)) {
      const coordinates = chain.nodes.map(nodePosition);
      push(
        FeatureTypeString.StandGuidanceLine,
        this.feature<LineString>({ type: 'LineString', coordinates }, { feattype: FeatureType.StandGuidanceLine }),
      );
    }

    this.synthesizeExitLines(taxiEdges, runwayNodes, nodePosition, push);
    this.synthesizeHoldingPositions(points, taxiEdges, nodePosition, push);
    this.synthesizeParkingStands(parkings, push);
  }

  /**
   * Synthesizes runway exit lines: taxi paths starting at a node of a runway centreline path,
   * walked away from the runway until an intersection or the maximum exit length.
   */
  private synthesizeExitLines(
    taxiEdges: TaxiEdge[],
    runwayNodes: Set<number>,
    nodePosition: (node: number) => Position,
    push: (type: FeatureTypeString, feature: AmdbFeature) => void,
  ): void {
    const adjacency = MsfsAmdbClient.buildAdjacency(taxiEdges);

    for (const startEdge of taxiEdges) {
      const aOnRunway = runwayNodes.has(startEdge.a);
      const bOnRunway = runwayNodes.has(startEdge.b);
      // paths crossing a runway (both ends on it) are not exits
      if (aOnRunway === bOnRunway) {
        continue;
      }

      const visited = new Set<TaxiEdge>([startEdge]);
      let current = aOnRunway ? startEdge.b : startEdge.a;
      const coordinates: Position[] = [nodePosition(aOnRunway ? startEdge.a : startEdge.b), nodePosition(current)];
      let length = MsfsAmdbClient.distance(coordinates[0], coordinates[1]);

      while (length < EXIT_LINE_MAX_LENGTH) {
        const nextEdges = (adjacency.get(current) ?? []).filter(
          (e) => !visited.has(e) && !runwayNodes.has(e.a === current ? e.b : e.a),
        );
        // stop at intersections and dead ends
        if (nextEdges.length !== 1) {
          break;
        }
        const edge = nextEdges[0];
        visited.add(edge);
        current = edge.a === current ? edge.b : edge.a;
        const position = nodePosition(current);
        length += MsfsAmdbClient.distance(coordinates[coordinates.length - 1], position);
        coordinates.push(position);
      }

      push(
        FeatureTypeString.RunwayExitLine,
        this.feature<LineString>(
          { type: 'LineString', coordinates },
          {
            feattype: FeatureType.RunwayExitLine,
            idlin: startEdge.name.length > 0 ? startEdge.name : undefined,
          },
        ),
      );
    }
  }

  private synthesizeHoldingPositions(
    points: [number, number, number, number][],
    taxiEdges: TaxiEdge[],
    nodePosition: (node: number) => Position,
    push: (type: FeatureTypeString, feature: AmdbFeature) => void,
  ): void {
    const adjacency = MsfsAmdbClient.buildAdjacency(taxiEdges);

    for (let i = 0; i < points.length; i++) {
      const type = points[i][0];
      if (type !== MsfsTaxiPointType.HoldShort && type !== MsfsTaxiPointType.IlsHoldShort) {
        continue;
      }

      const edge = (adjacency.get(i) ?? [])[0];
      if (!edge) {
        continue;
      }

      const nodePos = nodePosition(i);
      const otherPos = nodePosition(edge.a === i ? edge.b : edge.a);
      const dx = otherPos[0] - nodePos[0];
      const dy = otherPos[1] - nodePos[1];
      const segmentLength = Math.hypot(dx, dy);
      if (segmentLength < 1) {
        continue;
      }

      const halfBar = edge.width / 2;
      const perp = [(-dy / segmentLength) * halfBar, (dx / segmentLength) * halfBar];

      push(
        FeatureTypeString.TaxiwayHoldingPosition,
        this.feature<LineString>(
          {
            type: 'LineString',
            coordinates: [
              [nodePos[0] - perp[0], nodePos[1] - perp[1]],
              [nodePos[0] + perp[0], nodePos[1] + perp[1]],
            ],
          },
          { feattype: FeatureType.TaxiwayHoldingPosition, idlin: edge.name.length > 0 ? edge.name : undefined },
        ),
      );
    }
  }

  private synthesizeParkingStands(
    parkings: [number, number, number, number, number, number, number, number][],
    push: (type: FeatureTypeString, feature: AmdbFeature) => void,
  ): void {
    for (const [type, name, suffix, number, , radius, biasX, biasZ] of parkings) {
      if (NON_STAND_PARKING_TYPES.includes(type)) {
        continue;
      }

      const idstd = MsfsAmdbClient.parkingStandName(name, number, suffix);
      const position: Position = [biasX, biasZ];

      push(
        FeatureTypeString.ParkingStandLocation,
        this.feature<Point>(
          { type: 'Point', coordinates: position },
          {
            feattype: FeatureType.ParkingStandLocation,
            idstd: idstd.length > 0 ? idstd : undefined,
            termref: idstd.length > 0 ? idstd : undefined,
          },
        ),
      );

      if (radius > 0) {
        const ring: Position[] = [];
        for (let i = 0; i <= 16; i++) {
          const angle = (i / 16) * 2 * Math.PI;
          ring.push([position[0] + Math.cos(angle) * radius, position[1] + Math.sin(angle) * radius]);
        }
        push(
          FeatureTypeString.ParkingStandArea,
          this.feature<Polygon>(
            { type: 'Polygon', coordinates: [ring] },
            { feattype: FeatureType.ParkingStandArea, idstd: idstd.length > 0 ? idstd : undefined },
          ),
        );
      }
    }
  }

  // =============================================================================================
  // Static helpers
  // =============================================================================================

  private static runwayEndIdent(number: number, designator: number): string {
    return `${number.toString().padStart(2, '0')}${DESIGNATOR_LETTERS[designator] ?? ''}`;
  }

  /** Length of a [length, width] runway pavement (threshold/blastpad/overrun), 0 if absent */
  private static pavementLength(pavement?: [number, number]): number {
    return pavement?.[0] ?? 0;
  }

  /** Width of a [length, width] runway pavement, falling back to the given width if absent/zero */
  private static pavementWidth(pavement: [number, number] | undefined, fallback: number): number {
    const width = pavement?.[1] ?? 0;
    return width > 0 ? width : fallback;
  }

  private static normalizeHeading(heading: number): number {
    return ((heading % 360) + 360) % 360;
  }

  private static distance(a: Position, b: Position): number {
    return Math.hypot(b[0] - a[0], b[1] - a[1]);
  }

  private static medianWidth(widths: number[]): number {
    const sorted = [...widths].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  /** Formats a TAXI_PARKING name/number/suffix triple into an AMDB-style stand name, e.g. GATE_A/12/NONE -> "A12" */
  private static parkingStandName(name: number, number: number, suffix: number): string {
    let prefix = '';
    if (name >= 12 && name <= 37) {
      prefix = String.fromCharCode(65 + name - 12);
    } else if (name >= 2 && name <= 9) {
      prefix = PARKING_DIRECTION_PREFIXES[name - 2];
    }

    const suffixLetter = suffix >= 12 && suffix <= 37 ? String.fromCharCode(65 + suffix - 12) : '';

    return `${prefix}${number > 0 ? number : ''}${suffixLetter}`;
  }

  private static buildAdjacency(edges: TaxiEdge[]): Map<number, TaxiEdge[]> {
    const adjacency = new Map<number, TaxiEdge[]>();
    for (const edge of edges) {
      for (const node of [edge.a, edge.b]) {
        const list = adjacency.get(node);
        if (list) {
          list.push(edge);
        } else {
          adjacency.set(node, [edge]);
        }
      }
    }
    return adjacency;
  }

  /**
   * Chains individual edges into maximal polylines (each edge used exactly once), so that e.g.
   * all segments of taxiway "A" between two intersections become a single feature.
   */
  private static chainEdges(edges: TaxiEdge[]): { nodes: number[]; widths: number[] }[] {
    const adjacency = MsfsAmdbClient.buildAdjacency(edges);
    const visited = new Set<TaxiEdge>();
    const chains: { nodes: number[]; widths: number[] }[] = [];

    const takeNextEdge = (node: number): TaxiEdge | undefined =>
      (adjacency.get(node) ?? []).find((e) => !visited.has(e));

    for (const edge of edges) {
      if (visited.has(edge)) {
        continue;
      }
      visited.add(edge);

      const nodes = [edge.a, edge.b];
      const widths = [edge.width, edge.width];

      // extend at the tail
      for (let next = takeNextEdge(nodes[nodes.length - 1]); next; next = takeNextEdge(nodes[nodes.length - 1])) {
        visited.add(next);
        const tail = nodes[nodes.length - 1];
        nodes.push(next.a === tail ? next.b : next.a);
        widths[widths.length - 1] = Math.max(widths[widths.length - 1], next.width);
        widths.push(next.width);
      }

      // extend at the head
      for (let next = takeNextEdge(nodes[0]); next; next = takeNextEdge(nodes[0])) {
        visited.add(next);
        const head = nodes[0];
        nodes.unshift(next.a === head ? next.b : next.a);
        widths[0] = Math.max(widths[0], next.width);
        widths.unshift(next.width);
      }

      chains.push({ nodes, widths });
    }

    return chains;
  }

  /**
   * Extrudes a polyline into a pavement polygon, offsetting each vertex by half the local width
   * perpendicular to the line, with a clamped miter at joints.
   */
  private static extrudePolyline(coordinates: Position[], widths: number[]): Polygon {
    const n = coordinates.length;
    const left: Position[] = [];
    const right: Position[] = [];

    for (let i = 0; i < n; i++) {
      // segment normals before and after the vertex
      const prev = i > 0 ? MsfsAmdbClient.segmentNormal(coordinates[i - 1], coordinates[i]) : undefined;
      const next = i < n - 1 ? MsfsAmdbClient.segmentNormal(coordinates[i], coordinates[i + 1]) : undefined;

      let nx: number;
      let ny: number;
      let scale = 1;

      if (prev && next) {
        nx = prev[0] + next[0];
        ny = prev[1] + next[1];
        const len = Math.hypot(nx, ny);
        if (len < 1e-6) {
          // 180 degree turn - fall back to the previous normal
          [nx, ny] = prev;
        } else {
          nx /= len;
          ny /= len;
          // miter scale, clamped to avoid spikes at sharp corners
          const cosHalfAngle = nx * prev[0] + ny * prev[1];
          scale = Math.min(2, 1 / Math.max(0.5, cosHalfAngle));
        }
      } else {
        [nx, ny] = prev ?? next ?? [0, 0];
      }

      const halfWidth = (widths[i] ?? widths[widths.length - 1] ?? 15) / 2;
      const offset = halfWidth * scale;

      left.push([coordinates[i][0] + nx * offset, coordinates[i][1] + ny * offset]);
      right.push([coordinates[i][0] - nx * offset, coordinates[i][1] - ny * offset]);
    }

    right.reverse();
    const ring = [...left, ...right, left[0]];

    return { type: 'Polygon', coordinates: [ring] };
  }

  private static segmentNormal(a: Position, b: Position): [number, number] {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) {
      return [0, 0];
    }
    return [-dy / len, dx / len];
  }
}

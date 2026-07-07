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
  EventBus,
  FacilityLoader,
  FacilityRepository,
  FacilitySearchType,
  FacilityType,
  ICAO,
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

/** Radius around the aircraft used for the airport search, in metres */
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
    const lat = SimVar.GetSimVarValue('PLANE LATITUDE', 'degree latitude');
    const long = SimVar.GetSimVarValue('PLANE LONGITUDE', 'degree longitude');

    if (!this.facilityLoader) {
      this.facilityLoader = new FacilityLoader(FacilityRepository.getRepository(this.bus));
    }
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

    const facilities = await Promise.all(
      [...this.nearbyAirportIcaos].map((icao) =>
        this.facilityLoader.getFacility(FacilityType.Airport, icao).catch(() => null),
      ),
    );

    const query = queryString.trim().toUpperCase();

    return facilities
      .filter((fac) => fac !== null)
      .map((fac) => ({
        idarpt: ICAO.getIdent(fac.icao).trim(),
        iata: null,
        name: typeof Utils !== 'undefined' ? Utils.Translate(fac.name) ?? fac.name : fac.name,
        coordinates: { lat: fac.lat, lon: fac.lon },
        elev: 0,
      }))
      .filter((arpt) => query.length === 0 || arpt.idarpt.startsWith(query) || arpt.name.toUpperCase().includes(query))
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
    const halfWid = runway.wid / 2;

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

    const rectangle = (from: Position, to: Position): Polygon => ({
      type: 'Polygon',
      coordinates: [
        [
          across(from, halfWid),
          across(to, halfWid),
          across(to, -halfWid),
          across(from, -halfWid),
          across(from, halfWid),
        ],
      ],
    });

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
      [along(primaryEnd, runway.pthr), primaryIdent, runway.hdg, runway.pthr],
      [
        along(secondaryEnd, -runway.sthr),
        secondaryIdent,
        MsfsAmdbClient.normalizeHeading(runway.hdg + 180),
        runway.sthr,
      ],
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

    if (runway.pthr > 0) {
      push(
        FeatureTypeString.RunwayDisplacedArea,
        this.feature(rectangle(primaryEnd, along(primaryEnd, runway.pthr)), {
          feattype: FeatureType.RunwayDisplacedArea,
          idrwy,
        }),
      );
    }
    if (runway.sthr > 0) {
      push(
        FeatureTypeString.RunwayDisplacedArea,
        this.feature(rectangle(along(secondaryEnd, -runway.sthr), secondaryEnd), {
          feattype: FeatureType.RunwayDisplacedArea,
          idrwy,
        }),
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
          this.feature(MsfsAmdbClient.extrudePolyline(coordinates, chain.widths), {
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
        this.feature(MsfsAmdbClient.extrudePolyline(coordinates, chain.widths), {
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

  private static normalizeHeading(heading: number): number {
    return ((heading % 360) + 360) % 360;
  }

  private static distance(a: Position, b: Position): number {
    return Math.hypot(b[0] - a[0], b[1] - a[1]);
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

// Copyright (c) 2021-2026 FlyByWire Simulations
// Copyright (c) 2021-2022 Synaptic Simulations
//
// SPDX-License-Identifier: GPL-3.0

import {
  EfisNdMode,
  EfisSide,
  EfisVectorsGroup,
  GenericDataListenerSync,
  RegisteredSimVar,
} from '@flybywiresim/fbw-sdk';

import { Coordinates } from '@fmgc/flightplanning/data/geo';
import { GuidanceController } from '@fmgc/guidance/GuidanceController';
import { PathVector, PathVectorType, pathVectorLength, pathVectorValid } from '@fmgc/guidance/lnav/PathVector';
import { ArmedLateralMode, isArmed, LateralMode } from '@shared/autopilot';
import { FlightPlanIndex } from '@fmgc/flightplanning/FlightPlanManager';
import { FlightPlanService } from '@fmgc/flightplanning/FlightPlanService';
import { EfisInterface } from '@fmgc/efis/EfisInterface';
import { ReadonlyFlightPlan } from '@fmgc/flightplanning/plans/ReadonlyFlightPlan';
import { FmgcFlightPhase } from '@shared/flightphase';
import { ConsumerValue, EventBus, SimVarValueType } from '@microsoft/msfs-sdk';
import { FlightPhaseManagerEvents } from '@fmgc/flightphase';
import { FlightPlanUtils } from '@fmgc/flightplanning/FlightPlanUtils';

const UPDATE_TIMER = 2_500;

// how often identical vectors are re-sent anyway, so a reloaded instrument recovers its data
const KEEP_ALIVE_TIMER = 30_000;

export class EfisVectors {
  private syncer: GenericDataListenerSync = new GenericDataListenerSync();

  private lastFpVersions = new Map<number, number>();

  private lastEfisInterfaceVersions: Record<EfisSide, number> = { L: -1, R: -1 };

  private readonly flightPhase = ConsumerValue.create(
    this.bus.getSubscriber<FlightPhaseManagerEvents>().on('fmgc_flight_phase'),
    FmgcFlightPhase.Preflight,
  );

  private readonly lateralArmedMode = RegisteredSimVar.create('L:A32NX_FMA_LATERAL_ARMED', SimVarValueType.Enum);

  private readonly lateralActiveMode = RegisteredSimVar.create<LateralMode>(
    'L:A32NX_FMA_LATERAL_MODE',
    SimVarValueType.Enum,
  );

  private readonly eoSidVectorCache: PathVector[] = [];

  constructor(
    private readonly bus: EventBus,
    private readonly flightPlanService: FlightPlanService,
    private guidanceController: GuidanceController,
    private efisInterfaces: Record<EfisSide, EfisInterface>,
  ) {}

  public forceUpdate() {
    this.updateTimer = UPDATE_TIMER + 1;
  }

  private updateTimer = 0;

  private keepAliveTimer = 0;

  private keepAliveResync = false;

  private readonly lastTransmitted: Record<EfisSide, Map<EfisVectorsGroup, PathVector[] | null>> = {
    L: new Map(),
    R: new Map(),
  };

  public update(deltaTime: number): void {
    this.updateTimer += deltaTime;
    this.keepAliveTimer += deltaTime;

    if (this.updateTimer >= UPDATE_TIMER) {
      // A reloaded or late-attached instrument only recovers its vectors when they are re-sent,
      // so the transmit dedupe is bypassed once in a while
      if (this.keepAliveTimer >= KEEP_ALIVE_TIMER) {
        this.keepAliveTimer = 0;
        this.keepAliveResync = true;
      }
      this.updateSide('L', true);
      this.updateSide('R', true);
      this.keepAliveResync = false;
      this.updateTimer = 0;
    } else {
      this.updateSide('L');
      this.updateSide('R');
    }
  }

  private updateSide(side: EfisSide, force = false): void {
    if (force || this.lastEfisInterfaceVersions[side] !== this.efisInterfaces[side].version) {
      this.lastEfisInterfaceVersions[side] = this.efisInterfaces[side].version;

      this.tryProcessFlightPlan(FlightPlanIndex.Active, side, true);
      this.tryProcessFlightPlan(FlightPlanIndex.Temporary, side, true);

      for (let i = 1; i <= this.efisInterfaces[side].numSecondaryFlightPlans; i++) {
        this.tryProcessFlightPlan(FlightPlanIndex.FirstSecondary + i - 1, side, true);
      }

      // TODO why is this using different path vectors to the transmit calls
      const activeFlightPlanVectors =
        this.guidanceController.activeGeometry?.getAllPathVectors(this.guidanceController.activeLegIndex) ?? [];

      const visibleActiveFlightPlanVectors = activeFlightPlanVectors.filter((vector) =>
        EfisVectors.isVectorReasonable(vector),
      );

      if (visibleActiveFlightPlanVectors.length !== activeFlightPlanVectors.length) {
        this.guidanceController.efisStateForSide[side].legsCulled = true;
      } else {
        this.guidanceController.efisStateForSide[side].legsCulled = false;
      }
    } else {
      this.tryProcessFlightPlan(FlightPlanIndex.Active, side);
      this.tryProcessFlightPlan(FlightPlanIndex.Temporary, side);

      for (let i = 1; i <= this.efisInterfaces[side].numSecondaryFlightPlans; i++) {
        this.tryProcessFlightPlan(FlightPlanIndex.FirstSecondary + i - 1, side);
      }
    }
  }

  /**
   * Protect against potential perf issues from immense vectors
   */
  private static isVectorReasonable(vector: PathVector): boolean {
    if (!pathVectorValid(vector)) {
      return false;
    }

    const length = pathVectorLength(vector);

    return length <= 5_000;
  }

  private tryProcessFlightPlan(planIndex: FlightPlanIndex, side: EfisSide, force = false) {
    const planExists = this.flightPlanService.has(planIndex);

    if (!planExists) {
      this.lastFpVersions.delete(planIndex);

      switch (planIndex) {
        case FlightPlanIndex.Active:
          this.transmit(null, EfisVectorsGroup.ACTIVE, side);
          this.transmit(null, EfisVectorsGroup.DASHED, side);
          this.transmit(null, EfisVectorsGroup.MISSED, side);
          this.transmit(null, EfisVectorsGroup.ALTERNATE, side);
          this.transmit(null, EfisVectorsGroup.ACTIVE_EOSID, side);
          break;
        case FlightPlanIndex.Temporary:
          this.transmit(null, EfisVectorsGroup.TEMPORARY, side);
          break;
        case FlightPlanIndex.FirstSecondary:
        case FlightPlanIndex.Uplink:
        default:
          if (!this.efisInterfaces[side].shouldTransmitAnySecondary()) {
            this.transmit(null, EfisVectorsGroup.SECONDARY, side);
          }
          break;
      }

      return;
    }

    const plan = this.flightPlanService.get(planIndex);

    if (!force && this.lastFpVersions.get(planIndex) === plan.version) {
      return;
    }

    this.lastFpVersions.set(planIndex, plan.version);

    switch (planIndex) {
      case FlightPlanIndex.Active: {
        const engagedLateralMode = this.lateralActiveMode.get();
        const flightPhase = this.flightPhase.get();

        const transmitActive = (() => {
          switch (flightPhase) {
            // In preflight phase active vectors are always transmitted.
            case FmgcFlightPhase.Preflight:
              return true;
            case FmgcFlightPhase.Takeoff:
              return (
                engagedLateralMode === LateralMode.NAV || isArmed(this.lateralArmedMode.get(), ArmedLateralMode.NAV)
              );
            default:
              return (
                engagedLateralMode !== LateralMode.NONE &&
                engagedLateralMode !== LateralMode.HDG &&
                engagedLateralMode !== LateralMode.TRACK &&
                engagedLateralMode !== LateralMode.GA_TRACK &&
                engagedLateralMode !== LateralMode.RWY_TRACK
              );
          }
        })();

        if (transmitActive) {
          this.transmitFlightPlan(
            plan,
            side,
            EfisVectorsGroup.ACTIVE,
            EfisVectorsGroup.MISSED,
            EfisVectorsGroup.ALTERNATE,
            EfisVectorsGroup.ACTIVE_EOSID,
          );
          this.transmit(null, EfisVectorsGroup.DASHED, side);
        } else {
          this.transmit(null, EfisVectorsGroup.ACTIVE, side);
          this.transmitFlightPlan(
            plan,
            side,
            EfisVectorsGroup.DASHED,
            EfisVectorsGroup.MISSED,
            EfisVectorsGroup.ALTERNATE,
            EfisVectorsGroup.ACTIVE_EOSID,
          );
        }
        break;
      }
      case FlightPlanIndex.Temporary:
        this.transmitFlightPlan(plan, side, EfisVectorsGroup.TEMPORARY);
        break;
      default:
        if (this.efisInterfaces[side].shouldTransmitSecondary(planIndex - FlightPlanIndex.FirstSecondary + 1)) {
          this.transmitFlightPlan(plan, side, EfisVectorsGroup.SECONDARY);
        } else if (!this.efisInterfaces[side].shouldTransmitAnySecondary()) {
          this.transmit(null, EfisVectorsGroup.SECONDARY, side);
        }
        break;
    }
  }

  private transmitFlightPlan(
    plan: ReadonlyFlightPlan,
    side: EfisSide,
    mainGroup: EfisVectorsGroup,
    missedApproachGroup = mainGroup,
    alternateGroup = mainGroup,
    eosidGroup?: EfisVectorsGroup,
  ) {
    const mode: EfisNdMode = SimVar.GetSimVarValue(`L:A32NX_EFIS_${side}_ND_MODE`, 'number');
    const isPlanMode = mode === EfisNdMode.PLAN;

    if (!this.guidanceController.hasGeometryForFlightPlan(plan.index)) {
      this.transmit(null, mainGroup, side);

      if (missedApproachGroup !== mainGroup) {
        this.transmit(null, missedApproachGroup, side);
      }

      if (alternateGroup !== mainGroup) {
        this.transmit(null, alternateGroup, side);
      }

      if (eosidGroup) {
        this.transmit(null, eosidGroup, side);
      }

      return;
    }

    // ACTIVE

    const vectors = FlightPlanUtils.getAllPathVectorsInFlightPlan(plan, plan.activeLegIndex).filter((it) =>
      EfisVectors.isVectorReasonable(it),
    );

    // ACTIVE missed

    const transmitMissed = this.efisInterfaces[side].shouldTransmitMissed(plan.index, isPlanMode);

    if (transmitMissed) {
      const missedVectors = FlightPlanUtils.getAllPathVectorsInFlightPlan(plan, 0, true).filter((it) =>
        EfisVectors.isVectorReasonable(it),
      );

      if (missedApproachGroup === mainGroup) {
        vectors.push(...missedVectors);
      } else {
        this.transmit(missedVectors, missedApproachGroup, side);
      }
    } else if (missedApproachGroup !== mainGroup) {
      this.transmit(null, missedApproachGroup, side);
    }

    const transmitEosid = eosidGroup && this.efisInterfaces[side].shouldTransmitEosid(plan.index, isPlanMode);
    if (transmitEosid) {
      this.transmit(FlightPlanUtils.getEngineOutVectorsInFlightPlan(plan, this.eoSidVectorCache), eosidGroup, side);
    } else if (eosidGroup) {
      this.transmit(null, eosidGroup, side);
    }

    this.transmit(vectors, mainGroup, side);

    // ALTN

    const transmitAlternate = this.efisInterfaces[side].shouldTransmitAlternate(plan.index, isPlanMode);

    if (transmitAlternate) {
      const alternateGeometry = this.guidanceController.getGeometryForFlightPlan(plan.index, true);

      if (alternateGeometry) {
        const alternateVectors = alternateGeometry
          .getAllPathVectors(0)
          .filter((it) => EfisVectors.isVectorReasonable(it));

        // ALTN missed

        const transmitAlternateMissed = this.efisInterfaces[side].shouldTransmitAlternateMissed(plan.index, isPlanMode);

        if (transmitAlternateMissed) {
          const missedVectors = alternateGeometry
            .getAllPathVectors(0, true)
            .filter((it) => EfisVectors.isVectorReasonable(it));

          alternateVectors.push(...missedVectors);
        }

        if (alternateGroup === mainGroup) {
          vectors.push(...alternateVectors);
        } else {
          this.transmit(alternateVectors, alternateGroup, side);
        }
      } else if (alternateGroup !== mainGroup) {
        this.transmit(null, alternateGroup, side);
      }
    } else if (alternateGroup !== mainGroup) {
      this.transmit(null, alternateGroup, side);
    }
  }

  private transmit(vectors: PathVector[] | null, vectorsGroup: EfisVectorsGroup, side: EfisSide): void {
    // Most of the periodic forced updates re-produce identical content. Serializing the whole
    // path geometry through Coherent (and re-materializing it in every listening instrument)
    // on every cycle causes GC spikes with long flight plans, so identical content is only
    // re-sent by the occasional keep-alive resync.
    const lastTransmittedForSide = this.lastTransmitted[side];
    if (
      !this.keepAliveResync &&
      lastTransmittedForSide.has(vectorsGroup) &&
      EfisVectors.pathVectorsEqual(lastTransmittedForSide.get(vectorsGroup), vectors)
    ) {
      return;
    }
    // snapshot a copy, as the transmitted vectors come out of the live geometry
    lastTransmittedForSide.set(vectorsGroup, EfisVectors.clonePathVectors(vectors));

    this.syncer.sendEvent(`A32NX_EFIS_VECTORS_${side}_${EfisVectorsGroup[vectorsGroup]}`, vectors);
  }

  private static coordinatesEqual(a: Coordinates, b: Coordinates): boolean {
    return a.lat === b.lat && a.long === b.long;
  }

  private static pathVectorsEqual(a: PathVector[] | null, b: PathVector[] | null): boolean {
    if (a === null || b === null) {
      return a === b;
    }
    if (a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i++) {
      const va = a[i];
      const vb = b[i];
      if (va.type === PathVectorType.Line && vb.type === PathVectorType.Line) {
        if (
          !EfisVectors.coordinatesEqual(va.startPoint, vb.startPoint) ||
          !EfisVectors.coordinatesEqual(va.endPoint, vb.endPoint)
        ) {
          return false;
        }
      } else if (va.type === PathVectorType.Arc && vb.type === PathVectorType.Arc) {
        if (
          va.sweepAngle !== vb.sweepAngle ||
          !EfisVectors.coordinatesEqual(va.startPoint, vb.startPoint) ||
          !EfisVectors.coordinatesEqual(va.endPoint, vb.endPoint) ||
          !EfisVectors.coordinatesEqual(va.centrePoint, vb.centrePoint)
        ) {
          return false;
        }
      } else if (va.type === PathVectorType.DebugPoint && vb.type === PathVectorType.DebugPoint) {
        if (
          va.annotation !== vb.annotation ||
          va.colour !== vb.colour ||
          !EfisVectors.coordinatesEqual(va.startPoint, vb.startPoint)
        ) {
          return false;
        }
      } else {
        return false;
      }
    }
    return true;
  }

  private static clonePathVectors(vectors: PathVector[] | null): PathVector[] | null {
    if (vectors === null) {
      return null;
    }
    const copy: PathVector[] = new Array(vectors.length);
    for (let i = 0; i < vectors.length; i++) {
      const vector = vectors[i];
      switch (vector.type) {
        case PathVectorType.Line:
          copy[i] = {
            type: PathVectorType.Line,
            startPoint: { ...vector.startPoint },
            endPoint: { ...vector.endPoint },
          };
          break;
        case PathVectorType.Arc:
          copy[i] = {
            type: PathVectorType.Arc,
            startPoint: { ...vector.startPoint },
            endPoint: { ...vector.endPoint },
            centrePoint: { ...vector.centrePoint },
            sweepAngle: vector.sweepAngle,
          };
          break;
        default:
          copy[i] = {
            type: PathVectorType.DebugPoint,
            startPoint: { ...vector.startPoint },
            annotation: vector.annotation,
            colour: vector.colour,
          };
          break;
      }
    }
    return copy;
  }
}

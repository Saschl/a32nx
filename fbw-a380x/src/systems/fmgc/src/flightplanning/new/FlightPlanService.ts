// Copyright (c) 2021-2022 FlyByWire Simulations
// Copyright (c) 2021-2022 Synaptic Simulations
//
// SPDX-License-Identifier: GPL-3.0

import { FlightPlanIndex, FlightPlanManager } from '@fmgc/flightplanning/new/FlightPlanManager';
import { FpmConfig, FpmConfigs } from '@fmgc/flightplanning/new/FpmConfig';
import { FlightPlanLegFlags } from '@fmgc/flightplanning/new/legs/FlightPlanLeg';
import { AltitudeDescriptor, Fix, Waypoint } from 'msfs-navdata';
import { NavigationDatabase } from '@fmgc/NavigationDatabase';
import { Coordinates, Degrees } from 'msfs-geo';
import { EventBus } from '@microsoft/msfs-sdk';
import { FixInfoEntry } from '@fmgc/flightplanning/new/plans/FixInfo';
import { HoldData } from '@fmgc/flightplanning/data/flightplan';
import { FlightPlanLegDefinition } from '@fmgc/flightplanning/new/legs/FlightPlanLegDefinition';
import { FlightPlanInterface } from '@fmgc/flightplanning/new/FlightPlanInterface';

export class FlightPlanService implements FlightPlanInterface {
    private readonly flightPlanManager: FlightPlanManager;

    private config: FpmConfig = FpmConfigs.A320_HONEYWELL_H3;

    navigationDatabase: NavigationDatabase;

    constructor(
        private readonly bus: EventBus,
    ) {
        this.flightPlanManager = new FlightPlanManager(this.bus, Math.round(Math.random() * 10_000), true);
    }

    createFlightPlans() {
        this.flightPlanManager.create(FlightPlanIndex.Active);
        this.flightPlanManager.create(FlightPlanIndex.Uplink);
        this.flightPlanManager.create(FlightPlanIndex.FirstSecondary);
    }

    get(index: number) {
        return this.flightPlanManager.get(index);
    }

    has(index: number) {
        return this.flightPlanManager.has(index);
    }

    get active() {
        return this.flightPlanManager.get(FlightPlanIndex.Active);
    }

    get temporary() {
        return this.flightPlanManager.get(FlightPlanIndex.Temporary);
    }

    get activeOrTemporary() {
        if (this.hasTemporary) {
            return this.flightPlanManager.get(FlightPlanIndex.Temporary);
        }
        return this.flightPlanManager.get(FlightPlanIndex.Active);
    }

    get uplink() {
        return this.flightPlanManager.get(FlightPlanIndex.Uplink);
    }

    /**
     * Obtains the specified secondary flight plan, 1-indexed
     */
    secondary(index: number) {
        return this.flightPlanManager.get(FlightPlanIndex.FirstSecondary + index - 1);
    }

    get hasActive() {
        return this.flightPlanManager.has(FlightPlanIndex.Active);
    }

    get hasTemporary() {
        return this.flightPlanManager.has(FlightPlanIndex.Temporary);
    }

    hasSecondary(index: number) {
        return this.flightPlanManager.has(FlightPlanIndex.FirstSecondary + index - 1);
    }

    get hasUplink() {
        return this.flightPlanManager.has(FlightPlanIndex.Uplink);
    }

    async temporaryInsert(): Promise<void> {
        const temporaryPlan = this.flightPlanManager.get(FlightPlanIndex.Temporary);

        if (temporaryPlan.pendingAirways) {
            temporaryPlan.pendingAirways.finalize();
        }

        if (temporaryPlan.alternateFlightPlan.pendingAirways) {
            temporaryPlan.alternateFlightPlan.pendingAirways.finalize();
        }

        const fromLeg = temporaryPlan.maybeElementAt(temporaryPlan.activeLegIndex - 1);

        // Update T-P
        if (fromLeg?.isDiscontinuity === false && fromLeg.flags & FlightPlanLegFlags.DirectToTurningPoint) {
            // TODO fm pos
            fromLeg.definition.waypoint.location.lat = SimVar.GetSimVarValue('PLANE LATITUDE', 'Degrees');
            fromLeg.definition.waypoint.location.long = SimVar.GetSimVarValue('PLANE LONGITUDE', 'Degrees');
        }

        this.flightPlanManager.copy(FlightPlanIndex.Temporary, FlightPlanIndex.Active);
        this.flightPlanManager.delete(FlightPlanIndex.Temporary);
    }

    async temporaryDelete(): Promise<void> {
        if (!this.hasTemporary) {
            throw new Error('[FMS/FPS] Cannot delete temporary flight plan if none exists');
        }

        this.flightPlanManager.delete(FlightPlanIndex.Temporary);
    }

    async uplinkInsert(): Promise<void> {
        if (!this.hasUplink) {
            throw new Error('[FMS/FPS] Cannot insert uplink flight plan if none exists');
        }

        this.flightPlanManager.copy(FlightPlanIndex.Uplink, FlightPlanIndex.Active);
        this.flightPlanManager.delete(FlightPlanIndex.Uplink);

        if (this.hasTemporary) {
            this.flightPlanManager.delete(FlightPlanIndex.Temporary);
        }
    }

    async reset(): Promise<void> {
        this.flightPlanManager.deleteAll();

        this.createFlightPlans();
    }

    private prepareDestructiveModification(planIndex: FlightPlanIndex) {
        let finalIndex = planIndex;
        if (planIndex === FlightPlanIndex.Active) {
            this.ensureTemporaryExists();

            finalIndex = FlightPlanIndex.Temporary;
        }

        return finalIndex;
    }

    async newCityPair(fromIcao: string, toIcao: string, altnIcao?: string, planIndex = FlightPlanIndex.Active) {
        if (planIndex === FlightPlanIndex.Temporary) {
            throw new Error('[FMS/FPM] Cannot enter new city pair on temporary flight plan');
        }

        if (planIndex === FlightPlanIndex.Active && this.flightPlanManager.has(FlightPlanIndex.Temporary)) {
            this.flightPlanManager.delete(FlightPlanIndex.Temporary);
        }

        if (this.flightPlanManager.has(planIndex)) {
            this.flightPlanManager.delete(planIndex);
        }
        this.flightPlanManager.create(planIndex);

        await this.flightPlanManager.get(planIndex).setOriginAirport(fromIcao);
        await this.flightPlanManager.get(planIndex).setDestinationAirport(toIcao);
        if (altnIcao) {
            await this.flightPlanManager.get(planIndex).setAlternateDestinationAirport(altnIcao);
        }
    }

    async setAlternate(altnIcao: string, planIndex = FlightPlanIndex.Active) {
        if (planIndex === FlightPlanIndex.Temporary) {
            throw new Error('[FMS/FPM] Cannot set alternate on temporary flight plan');
        }

        const plan = this.flightPlanManager.get(planIndex);

        return plan.setAlternateDestinationAirport(altnIcao);
    }

    setOriginRunway(runwayIdent: string, planIndex = FlightPlanIndex.Active, alternate = false) {
        const finalIndex = this.prepareDestructiveModification(planIndex);

        const plan = alternate ? this.flightPlanManager.get(finalIndex).alternateFlightPlan : this.flightPlanManager.get(finalIndex);

        return plan.setOriginRunway(runwayIdent);
    }

    setDepartureProcedure(procedureIdent: string | undefined, planIndex = FlightPlanIndex.Active, alternate = false) {
        const finalIndex = this.prepareDestructiveModification(planIndex);

        const plan = alternate ? this.flightPlanManager.get(finalIndex).alternateFlightPlan : this.flightPlanManager.get(finalIndex);

        return plan.setDeparture(procedureIdent);
    }

    setDepartureEnrouteTransition(transitionIdent: string | undefined, planIndex = FlightPlanIndex.Active, alternate = false) {
        const finalIndex = this.prepareDestructiveModification(planIndex);

        const plan = alternate ? this.flightPlanManager.get(finalIndex).alternateFlightPlan : this.flightPlanManager.get(finalIndex);

        return plan.setDepartureEnrouteTransition(transitionIdent);
    }

    setArrivalEnrouteTransition(transitionIdent: string | undefined, planIndex = FlightPlanIndex.Active, alternate = false) {
        const finalIndex = this.prepareDestructiveModification(planIndex);

        const plan = alternate ? this.flightPlanManager.get(finalIndex).alternateFlightPlan : this.flightPlanManager.get(finalIndex);

        return plan.setArrivalEnrouteTransition(transitionIdent);
    }

    setArrival(procedureIdent: string | undefined, planIndex = FlightPlanIndex.Active, alternate = false) {
        const finalIndex = this.prepareDestructiveModification(planIndex);

        const plan = alternate ? this.flightPlanManager.get(finalIndex).alternateFlightPlan : this.flightPlanManager.get(finalIndex);

        return plan.setArrival(procedureIdent);
    }

    setApproachVia(procedureIdent: string | undefined, planIndex = FlightPlanIndex.Active, alternate = false) {
        const finalIndex = this.prepareDestructiveModification(planIndex);

        const plan = alternate ? this.flightPlanManager.get(finalIndex).alternateFlightPlan : this.flightPlanManager.get(finalIndex);

        return plan.setApproachVia(procedureIdent);
    }

    setApproach(procedureIdent: string | undefined, planIndex = FlightPlanIndex.Active, alternate = false) {
        const finalIndex = this.prepareDestructiveModification(planIndex);

        const plan = alternate ? this.flightPlanManager.get(finalIndex).alternateFlightPlan : this.flightPlanManager.get(finalIndex);

        return plan.setApproach(procedureIdent);
    }

    setDestinationRunway(runwayIdent: string, planIndex = FlightPlanIndex.Active, alternate = false) {
        const finalIndex = this.prepareDestructiveModification(planIndex);

        const plan = alternate ? this.flightPlanManager.get(finalIndex).alternateFlightPlan : this.flightPlanManager.get(finalIndex);

        return plan.setDestinationRunway(runwayIdent);
    }

    async deleteElementAt(index: number, planIndex = FlightPlanIndex.Active, alternate = false): Promise<boolean> {
        if (!this.config.ALLOW_REVISIONS_ON_TMPY && planIndex === FlightPlanIndex.Temporary) {
            throw new Error('[FMS/FPS] Cannot delete element in temporary flight plan');
        }

        let finalIndex: number = planIndex;
        if (this.config.TMPY_ON_DELETE_WAYPOINT) {
            finalIndex = this.prepareDestructiveModification(planIndex);
        }

        const plan = alternate ? this.flightPlanManager.get(finalIndex).alternateFlightPlan : this.flightPlanManager.get(finalIndex);

        return plan.removeElementAt(index);
    }

    async insertWaypointBefore(atIndex: number, waypoint: Fix, planIndex = FlightPlanIndex.Active, alternate = false) {
        const finalIndex = this.prepareDestructiveModification(planIndex);

        const plan = alternate ? this.flightPlanManager.get(finalIndex).alternateFlightPlan : this.flightPlanManager.get(finalIndex);

        await plan.insertWaypointBefore(atIndex, waypoint);
    }

    async nextWaypoint(atIndex: number, waypoint: Fix, planIndex = FlightPlanIndex.Active, alternate = false) {
        const finalIndex = this.prepareDestructiveModification(planIndex);

        const plan = alternate ? this.flightPlanManager.get(finalIndex).alternateFlightPlan : this.flightPlanManager.get(finalIndex);

        await plan.nextWaypoint(atIndex, waypoint);
    }

    async newDest(atIndex: number, airportIdent: string, planIndex = FlightPlanIndex.Active, alternate = false) {
        const finalIndex = this.prepareDestructiveModification(planIndex);

        const plan = alternate ? this.flightPlanManager.get(finalIndex).alternateFlightPlan : this.flightPlanManager.get(finalIndex);

        await plan.newDest(atIndex, airportIdent);
    }

    async startAirwayEntry(at: number, planIndex = FlightPlanIndex.Active, alternate = false) {
        const finalIndex = this.prepareDestructiveModification(planIndex);

        const plan = alternate ? this.flightPlanManager.get(finalIndex).alternateFlightPlan : this.flightPlanManager.get(finalIndex);

        plan.startAirwayEntry(at);
    }

    async directTo(ppos: Coordinates, trueTrack: Degrees, waypoint: Fix, withAbeam = false, planIndex = FlightPlanIndex.Active) {
        const finalIndex = this.prepareDestructiveModification(planIndex);

        const plan = this.flightPlanManager.get(finalIndex);

        plan.directTo(ppos, trueTrack, waypoint, withAbeam);
    }

    async addOrEditManualHold(at: number, desiredHold: HoldData, modifiedHold: HoldData, defaultHold: HoldData, planIndex = FlightPlanIndex.Active, alternate = false): Promise<number> {
        const finalIndex = this.prepareDestructiveModification(planIndex);

        const plan = alternate ? this.flightPlanManager.get(finalIndex).alternateFlightPlan : this.flightPlanManager.get(finalIndex);

        return plan.addOrEditManualHold(at, desiredHold, modifiedHold, defaultHold);
    }

    async revertHoldToComputed(at: number, planIndex = FlightPlanIndex.Active, alternate = false) {
        const finalIndex = this.prepareDestructiveModification(planIndex);

        const plan = alternate ? this.flightPlanManager.get(finalIndex).alternateFlightPlan : this.flightPlanManager.get(finalIndex);

        plan.revertHoldToComputed(at);
    }

    async enableAltn(atIndexInAlternate: number, planIndex = FlightPlanIndex.Active) {
        const finalIndex = this.prepareDestructiveModification(planIndex);

        const plan = this.flightPlanManager.get(finalIndex);

        await plan.enableAltn(atIndexInAlternate);
    }

    async setAltitudeDescriptionAt(atIndex: number, altDesc: AltitudeDescriptor, isDescentConstraint: boolean, planIndex?: FlightPlanIndex, alternate?: boolean): Promise<void> {
        const finalIndex = this.config.TMPY_ON_CONSTRAINT_EDIT ? this.prepareDestructiveModification(planIndex) : planIndex;

        const plan = alternate ? this.flightPlanManager.get(finalIndex).alternateFlightPlan : this.flightPlanManager.get(finalIndex);

        plan.setAltitudeDescriptionAt(atIndex, altDesc);
    }

    async setAltitudeAt(atIndex: number, altitude: number, isDescentConstraint: boolean, planIndex?: FlightPlanIndex, alternate?: boolean) {
        const finalIndex = this.config.TMPY_ON_CONSTRAINT_EDIT ? this.prepareDestructiveModification(planIndex) : planIndex;

        const plan = alternate ? this.flightPlanManager.get(finalIndex).alternateFlightPlan : this.flightPlanManager.get(finalIndex);

        plan.setAltitudeAt(atIndex, altitude, isDescentConstraint);
    }

    async setSpeedAt(atIndex: number, speed: number, isDescentConstraint: boolean, planIndex = FlightPlanIndex.Active, alternate = false) {
        const finalIndex = this.config.TMPY_ON_CONSTRAINT_EDIT ? this.prepareDestructiveModification(planIndex) : planIndex;

        const plan = alternate ? this.flightPlanManager.get(finalIndex).alternateFlightPlan : this.flightPlanManager.get(finalIndex);

        plan.setSpeedAt(atIndex, speed, isDescentConstraint);
    }

    async addOrUpdateCruiseStep(atIndex: number, toAltitude: number, planIndex = FlightPlanIndex.Active): Promise<void> {
        const finalIndex = this.config.TMPY_ON_CONSTRAINT_EDIT ? this.prepareDestructiveModification(planIndex) : planIndex;

        const plan = this.flightPlanManager.get(finalIndex);

        plan.addOrUpdateCruiseStep(atIndex, toAltitude);
    }

    async removeCruiseStep(atIndex: number, planIndex?: FlightPlanIndex): Promise<void> {
        const finalIndex = this.config.TMPY_ON_CONSTRAINT_EDIT ? this.prepareDestructiveModification(planIndex) : planIndex;

        const plan = this.flightPlanManager.get(finalIndex);

        plan.removeCruiseStep(atIndex);
    }

    async editLegDefinition(atIndex: number, changes: Partial<FlightPlanLegDefinition>, planIndex = FlightPlanIndex.Active, alternate = false) {
        const finalIndex = this.prepareDestructiveModification(planIndex);

        const plan = alternate ? this.flightPlanManager.get(finalIndex).alternateFlightPlan : this.flightPlanManager.get(finalIndex);

        return plan.editLegDefinition(atIndex, changes);
    }

    async setOverfly(atIndex: number, overfly: boolean, planIndex = FlightPlanIndex.Active) {
        let finalIndex: number = planIndex;
        if (this.config.TMPY_ON_OVERFLY) {
            finalIndex = this.prepareDestructiveModification(planIndex);
        }

        const plan = this.flightPlanManager.get(finalIndex);

        return plan.setOverflyAt(atIndex, overfly);
    }

    async toggleOverfly(atIndex: number, planIndex = FlightPlanIndex.Active) {
        let finalIndex: number = planIndex;
        if (this.config.TMPY_ON_OVERFLY) {
            finalIndex = this.prepareDestructiveModification(planIndex);
        }

        const plan = this.flightPlanManager.get(finalIndex);

        return plan.toggleOverflyAt(atIndex);
    }

    async setFixInfoEntry(index: 1 | 2 | 3 | 4, fixInfo: FixInfoEntry | null, planIndex = FlightPlanIndex.Active) {
        if (!this.config.ALLOW_NON_ACTIVE_FIX_INFOS && planIndex !== FlightPlanIndex.Active) {
            throw new Error('FIX INFO can only be modified on the active flight plan');
        }

        const plan = this.flightPlanManager.get(planIndex);

        plan.setFixInfoEntry(index, fixInfo);
    }

    async editFixInfoEntry(index: 1 | 2 | 3 | 4, callback: (fixInfo: FixInfoEntry) => FixInfoEntry, planIndex = FlightPlanIndex.Active) {
        if (!this.config.ALLOW_NON_ACTIVE_FIX_INFOS && planIndex !== FlightPlanIndex.Active) {
            throw new Error('FIX INFO can only be modified on the active flight plan');
        }

        const plan = this.flightPlanManager.get(planIndex);

        plan.editFixInfoEntry(index, callback);
    }

    get activeLegIndex(): number {
        return this.active.activeLegIndex;
    }

    async isWaypointInUse(waypoint: Waypoint) {
        const activePlan = this.active;

        for (const leg of activePlan.allLegs) {
            if (leg.isDiscontinuity === false && leg.terminatesWithWaypoint(waypoint)) {
                return true;
            }
        }

        if (this.hasTemporary) {
            const temporaryPlan = this.temporary;

            for (const leg of temporaryPlan.allLegs) {
                if (leg.isDiscontinuity === false && leg.terminatesWithWaypoint(waypoint)) {
                    return true;
                }
            }
        }

        if (this.hasSecondary(1)) {
            const secondaryPlan = this.secondary(1);

            for (const leg of secondaryPlan.allLegs) {
                if (leg.isDiscontinuity === false && leg.terminatesWithWaypoint(waypoint)) {
                    return true;
                }
            }
        }

        return false;
    }

    private async ensureTemporaryExists() {
        if (this.hasTemporary) {
            return;
        }

        this.flightPlanManager.copy(FlightPlanIndex.Active, FlightPlanIndex.Temporary);
    }
}

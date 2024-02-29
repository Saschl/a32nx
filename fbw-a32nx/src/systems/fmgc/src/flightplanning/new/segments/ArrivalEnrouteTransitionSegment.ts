// Copyright (c) 2021-2022 FlyByWire Simulations
// Copyright (c) 2021-2022 Synaptic Simulations
//
// SPDX-License-Identifier: GPL-3.0

import { LegType, ProcedureTransition } from '@flybywiresim/fbw-sdk';
import { FlightPlanElement, FlightPlanLeg } from '@fmgc/flightplanning/new/legs/FlightPlanLeg';
import { BaseFlightPlan, FlightPlanQueuedOperation } from '@fmgc/flightplanning/new/plans/BaseFlightPlan';
import { SegmentClass } from '@fmgc/flightplanning/new/segments/SegmentClass';
import { ProcedureSegment } from '@fmgc/flightplanning/new/segments/ProcedureSegment';
import { WaypointConstraintType } from '@fmgc/flightplanning/FlightPlanManager';
import { RestringOptions } from '../plans/RestringOptions';

export class ArrivalEnrouteTransitionSegment extends ProcedureSegment<ProcedureTransition> {
    class = SegmentClass.Arrival

    allLegs: FlightPlanElement[] = []

    get procedure(): ProcedureTransition | undefined {
        return this.arrivalEnrouteTransition;
    }

    private arrivalEnrouteTransition: ProcedureTransition | undefined = undefined

    setProcedure(databaseId: string | undefined, skipUpdateLegs?: boolean): Promise<void> {
        if (databaseId === undefined) {
            this.arrivalEnrouteTransition = undefined;

            if (!skipUpdateLegs) {
                this.allLegs.length = 0;

                this.flightPlan.syncSegmentLegsChange(this);
            }

            return;
        }

        const { destinationAirport, arrival } = this.flightPlan;

        if (!destinationAirport || !arrival) {
            throw new Error('[FMS/FPM] Cannot set arrival enroute transition without destination airport and STAR');
        }

        const arrivalEnrouteTransitions = arrival.enrouteTransitions;

        const matchingArrivalEnrouteTransition = arrivalEnrouteTransitions.find((transition) => transition.databaseId === databaseId);

        if (!matchingArrivalEnrouteTransition) {
            throw new Error(`[FMS/FPM] Can't find arrival enroute transition '${databaseId}' for ${destinationAirport.ident} ${arrival.ident}`);
        }

        this.arrivalEnrouteTransition = matchingArrivalEnrouteTransition;

        if (skipUpdateLegs) {
            return;
        }

        this.allLegs.length = 0;

        const mappedArrivalEnrouteTransitionLegs = matchingArrivalEnrouteTransition.legs.map(
            (leg) => FlightPlanLeg.fromProcedureLeg(this, leg, matchingArrivalEnrouteTransition.ident, WaypointConstraintType.DES),
        );

        const firstArrivalEnrouteTransitionLeg = mappedArrivalEnrouteTransitionLegs[0];

        // Add an IF at the start if first leg of the transition is an FX
        if (firstArrivalEnrouteTransitionLeg?.isFX()) {
            const newLeg = FlightPlanLeg.fromEnrouteFix(this, firstArrivalEnrouteTransitionLeg.definition.waypoint, undefined, LegType.IF);

            this.allLegs.push(newLeg);
        }

        this.allLegs.push(...mappedArrivalEnrouteTransitionLegs);
        this.strung = false;

        this.flightPlan.syncSegmentLegsChange(this);
        this.flightPlan.enqueueOperation(FlightPlanQueuedOperation.RebuildArrivalAndApproach);
        this.flightPlan.enqueueOperation(FlightPlanQueuedOperation.Restring, RestringOptions.RestringArrival);
    }

    clone(forPlan: BaseFlightPlan): ArrivalEnrouteTransitionSegment {
        const newSegment = new ArrivalEnrouteTransitionSegment(forPlan);

        newSegment.strung = this.strung;
        newSegment.allLegs = [...this.allLegs.map((it) => (it.isDiscontinuity === false ? it.clone(newSegment) : it))];
        newSegment.arrivalEnrouteTransition = this.arrivalEnrouteTransition;

        return newSegment;
    }
}

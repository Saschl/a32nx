// Copyright (c) 2021-2023 FlyByWire Simulations
//
// SPDX-License-Identifier: GPL-3.0

class CDUProgressPage {
    static ShowPage(mcdu) {
        mcdu.clearDisplay();
        mcdu.page.Current = mcdu.page.ProgressPage;
        mcdu.returnPageCallback = () => {
            CDUProgressPage.ShowPage(mcdu);
        };
        mcdu.activeSystem = 'FMGC';
        const flightNo = SimVar.GetSimVarValue("ATC FLIGHT NUMBER", "string");
        const flMax = mcdu.getMaxFlCorrected();
        const flOpt = (mcdu._zeroFuelWeightZFWCGEntered && mcdu._blockFuelEntered && (mcdu.isAllEngineOn() || mcdu.isOnGround())) ? "{green}FL" + (Math.floor(flMax / 5) * 5).toString() + "{end}" : "-----";
        const adirsUsesGpsAsPrimary = SimVar.GetSimVarValue("L:A32NX_ADIRS_USES_GPS_AS_PRIMARY", "Bool");
        const gpsPrimaryStatus = adirsUsesGpsAsPrimary ? "{green}GPS PRIMARY{end}" : "";
        let flCrz = "-----";
        let vDevCell = "";
        switch (mcdu.flightPhaseManager.phase) {
            case FmgcFlightPhases.PREFLIGHT:
            case FmgcFlightPhases.TAKEOFF: {
                if (mcdu.flightPlanService.active.performanceData.cruiseFlightLevel.get()()) {
                    flCrz = "FL" + mcdu.flightPlanService.active.performanceData.cruiseFlightLevel.get()().toFixed(0).padStart(3, "0") + "[color]cyan";
                }
                break;
            }
            case FmgcFlightPhases.CLIMB: {
                const alt = Math.round(Simplane.getAutoPilotSelectedAltitudeLockValue("feet") / 100);
                const altCtn = Math.round(mcdu.constraintAlt / 100);
                if (!mcdu.flightPlanService.active.performanceData.cruiseFlightLevel.get()() && !mcdu._activeCruiseFlightLevelDefaulToFcu) {
                    flCrz = "FL" + (altCtn && alt > altCtn ? altCtn.toFixed(0).padStart(3, "0") : alt.toFixed(0).padStart(3, "0")) + "[color]cyan";
                } else {
                    flCrz = "FL" + mcdu.flightPlanService.active.performanceData.cruiseFlightLevel.get()().toFixed(0).padStart(3, "0") + "[color]cyan";
                }
                break;
            }
            case FmgcFlightPhases.CRUISE: {
                flCrz = "FL" + mcdu.flightPlanService.active.performanceData.cruiseFlightLevel.get()().toFixed(0).padStart(3, "0") + "[color]cyan";
                break;
            }
            case FmgcFlightPhases.DESCENT: {
                const vDev = mcdu.guidanceController.vnavDriver.getLinearDeviation();
                let vDevFormattedNumber = "{small}-----{end}";

                if (vDev && isFinite(vDev)) {
                    const paddedVdev = (10 * Math.round(vDev / 10)).toFixed(0).padStart(4, "\xa0");
                    const vDevSign = vDev > 0 ? "+" : " ";
                    const extraSpace = paddedVdev.length > 4 ? "" : "\xa0";

                    vDevFormattedNumber = "{green}" + extraSpace + vDevSign + paddedVdev + "{end}";
                }

                vDevCell = "{small}VDEV={end}" + vDevFormattedNumber + "{small}FT{end}";
            }
        }
        let flightPhase;
        switch (mcdu.flightPhaseManager.phase) {
            case FmgcFlightPhases.PREFLIGHT:
            case FmgcFlightPhases.TAKEOFF:
                flightPhase = "TO";
                break;
            case FmgcFlightPhases.CLIMB:
                flightPhase = "CLB";
                break;
            case FmgcFlightPhases.CRUISE:
                flightPhase = "CRZ";
                break;
            case FmgcFlightPhases.DESCENT:
                flightPhase = "DES";
                break;
            case FmgcFlightPhases.APPROACH:
                flightPhase = "APPR";
                break;
            case FmgcFlightPhases.GOAROUND:
                flightPhase = "GA";
                break;
            default:
                flightPhase = "";
                break;
        }

        mcdu.onLeftInput[0] = (value, scratchpadCallback) => {
            if (mcdu.trySetCruiseFlCheckInput(value)) {
                CDUProgressPage.ShowPage(mcdu);
            } else {
                scratchpadCallback();
            }
        };
        mcdu.leftInputDelay[1] = () => {
            return mcdu.getDelaySwitchPage();
        };
        mcdu.onLeftInput[1] = () => {
            CDUProgressPage.ShowReportPage(mcdu);
        };
        mcdu.leftInputDelay[4] = () => {
            return mcdu.getDelaySwitchPage();
        };
        mcdu.onLeftInput[4] = () => {
            CDUProgressPage.ShowPredictiveGPSPage(mcdu);
        };

        let progBearingDist = "{small}\xa0---°\xa0/----.-{end}";
        let progWaypoint = "[\xa0\xa0\xa0\xa0\xa0]";
        if (mcdu.progWaypointIdent !== undefined) {
            progWaypoint = mcdu.progWaypointIdent.padEnd("7", "\xa0");
            if (mcdu.progBearing > 0 && mcdu.progDistance > 0) {
                const distDigits = mcdu.progDistance > 9999 ? 0 : 1;
                progBearingDist = `{small}{green}\xa0${mcdu.progBearing.toFixed(0).padStart(3, "0")}°\xa0/${mcdu.progDistance.toFixed(distDigits).padStart(3)}{end}{end}`;
            }
        }
        // the actual query takes long enough...
        mcdu.rightInputDelay[3] = () => 0;
        mcdu.onRightInput[3] = (input, scratchpadCallback) => {
            mcdu.trySetProgWaypoint(input, (success) => {
                if (!success) {
                    scratchpadCallback(input);
                }

                CDUProgressPage.ShowPage(mcdu);
            });
        };

        let rnpCell = '-.-';
        const rnpSize = mcdu.navigation.requiredPerformance.manualRnp ? 'big' : 'small';
        const rnp = mcdu.navigation.requiredPerformance.activeRnp;
        // TODO check 2 decimal cut-off
        if (rnp > 1) {
            rnpCell = rnp.toFixed(1).padStart(4);
        } else if (rnp !== undefined) {
            rnpCell = rnp.toFixed(2);
        }

        mcdu.onLeftInput[5] = (input, scratchpadCallback) => {
            if (input === FMCMainDisplay.clrValue) {
                mcdu.navigation.requiredPerformance.clearPilotRnp();
                return CDUProgressPage.ShowPage(mcdu);
            }

            const match = input.match(/^\d{1,2}(\.\d{1,2})?$/);
            if (match === null) {
                mcdu.setScratchpadMessage(NXSystemMessages.formatError);
                scratchpadCallback(input);
                return;
            }

            const rnp = parseFloat(input);
            if (rnp < 0.01 || rnp > 20) {
                mcdu.setScratchpadMessage(NXSystemMessages.entryOutOfRange);
                scratchpadCallback(input);
                return;
            }

            mcdu.navigation.requiredPerformance.setPilotRnp(rnp);
            CDUProgressPage.ShowPage(mcdu);
        };

        let anpCell = '-.-';
        const anp = mcdu.navigation.currentPerformance;
        // TODO check 2 decimal cut-off
        if (anp > 1) {
            anpCell = anp.toFixed(1).padStart(4);
        } else if (anp !== undefined) {
            anpCell = anp.toFixed(2);
        }

        mcdu.setTemplate([
            ["{green}" + flightPhase.padStart(15, "\xa0") + "{end}\xa0" + flightNo.padEnd(11, "\xa0")],
            ["\xa0" + "CRZ\xa0", "OPT\xa0\xa0\xa0\xa0REC MAX"],
            [flCrz, flOpt + "\xa0\xa0\xa0\xa0" + "{magenta}FL" + flMax.toString() + "\xa0{end}"],
            [""],
            ["<REPORT", vDevCell],
            [adirsUsesGpsAsPrimary ? "" : "\xa0POSITION UPDATE AT"],
            [adirsUsesGpsAsPrimary ? "" : "{small}*{end}[\xa0\xa0\xa0\xa0][color]cyan"],
            ["\xa0\xa0BRG / DIST"],
            [progBearingDist, `{small}{white}TO{end}{end}\xa0{cyan}${progWaypoint}{end}`],
            ["\xa0PREDICTIVE"],
            ["<GPS", gpsPrimaryStatus],
            ["REQUIRED", "ESTIMATED", "ACCUR{sp}"],
            [`{cyan}{${rnpSize}}${rnpCell}NM{end}{end}`, `{green}{small}${anpCell}NM{end}{end}`, `{green}${mcdu.navigation.accuracyHigh ? 'HIGH' : 'LOW'}{end}`]
        ]);

        // regular update due to showing dynamic data on this page
        mcdu.page.SelfPtr = setTimeout(() => {
            if (mcdu.page.Current === mcdu.page.ProgressPage) {
                CDUProgressPage.ShowPage(mcdu);
            }
        }, mcdu.PageTimeout.Default);

    }

    static ShowReportPage(mcdu) {
        const plan = mcdu.flightPlanService.active;

        mcdu.clearDisplay();
        mcdu.page.Current = mcdu.page.ProgressPageReport;
        let altCell = "---";
        if (isFinite(mcdu.flightPlanService.active.performanceData.cruiseFlightLevel.get()())) {
            altCell = mcdu.flightPlanService.active.performanceData.cruiseFlightLevel.get()().toFixed(0);
        }
        mcdu.onRightInput[0] = (value, scratchpadCallback) => {
            if (mcdu.setCruiseFlightLevelAndTemperature(value)) {
                CDUProgressPage.ShowReportPage(mcdu);
            } else {
                scratchpadCallback();
            }
        };

        const toLeg = plan.activeLeg;
        let toWaypointCell = "";
        const toWaypointUTCCell = "---";
        const toWaypointAltCell = "----";
        let nextWaypointCell = "";
        const nextWaypointUTCCell = "----";
        const nextWaypointAltCell = "---";
        if (toLeg && toLeg.isDiscontinuity === false) {
            toWaypointCell = toLeg.ident;
            // toWaypointUTCCell = FMCMainDisplay.secondsTohhmm(toLeg.infos.etaInFP); TODO port over
            const nextLeg = plan.maybeElementAt(plan.activeLegIndex + 1);

            if (nextLeg && nextLeg.isDiscontinuity === false) {
                nextWaypointCell = nextLeg.ident;
                // nextWaypointUTCCell = FMCMainDisplay.secondsTohhmm(nextLeg.infos.etaInFP); TODO port over
            }
        }

        let destCell = "";
        const destUTCCell = "---";
        const destDistCell = "----";
        if (plan.destinationAirport) {
            destCell = plan.destinationAirport.ident;

            if (plan.destinationRunway) {
                destCell += plan.destinationRunway.ident.replace('RW', '');
            }

            // destUTCCell = FMCMainDisplay.secondsTohhmm(mcdu.flightPlanManager.getDestination().infos.etaInFP); TODO port over (fms-v2)
            // destDistCell = mcdu.flightPlanManager.getDestination().infos.totalDistInFP.toFixed(0); TODO port over (fms-v2)
        }

        mcdu.setTemplate([
            ["REPORT"],
            ["\xa0OVHD", "ALT\xa0", "UTC"],
            ["", altCell + "[color]cyan"],
            ["\xa0TO"],
            [toWaypointCell + "[color]green", toWaypointAltCell + "[color]green", toWaypointUTCCell + "[color]green"],
            ["\xa0NEXT"],
            [nextWaypointCell + "[color]green", nextWaypointAltCell + "[color]green", nextWaypointUTCCell + "[color]green"],
            ["\xa0SAT", "FOB\xa0", "T. WIND"],
            ["[][color]cyan"],
            ["\xa0S/C", "", "UTC DIST"],
            [""],
            ["\xa0DEST", "EFOB", "UTC DIST"],
            [destCell, "", destUTCCell + " " + destDistCell]
        ]);
    }

    static ShowPredictiveGPSPage(mcdu, overrideDestETA = "") {
        mcdu.clearDisplay();
        mcdu.page.Current = mcdu.page.ProgressPagePredictiveGPS;

        const plan = mcdu.flightPlanService.active;

        let destIdentCell = "";
        let destETACell = "";
        if (plan.destinationAirport) {
            destIdentCell = plan.destinationAirport.ident + "[color]green";

            if (overrideDestETA) {
                destETACell = overrideDestETA;
            } else {
                // destETACell = FMCMainDisplay.secondsTohhmm(mcdu.flightPlanManager.getDestination().infos.etaInFP); TODO port over (fms-v2)
            }

            mcdu.onRightInput[0] = (value) => {
                CDUProgressPage.ShowPredictiveGPSPage(mcdu, value);
            };
        }

        mcdu.setTemplate([
            ["PREDICTIVE GPS"],
            ["DEST", "ETA"],
            [destIdentCell, destETACell + "[color]cyan", "{small}PRIMARY{end}"],
            ["\xa0\xa0-15 -10 -5 ETA+5 +10 +15"],
            ["{small}\xa0\xa0\xa0\xa0Y\xa0\xa0Y\xa0\xa0\xa0Y\xa0\xa0Y\xa0\xa0Y\xa0\xa0\xa0Y\xa0\xa0Y{end}[color]green"],
            ["WPT", "ETA"],
            ["[ ][color]cyan", "", "{small}PRIMARY{end}"],
            ["\xa0\xa0-15 -10 -5 ETA+5 +10 +15"],
            [""],
            ["", "", "DESELECTED SATELLITES"],
            ["[ ][color]cyan"],
            [""],
            [""]
        ]);
    }
}

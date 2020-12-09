class CDUFlightPlanPage {
    static ShowPage(mcdu, offset = 0) {
        mcdu.clearDisplay();
        mcdu.page.Current = mcdu.page.FlightPlanPage;
        mcdu.activeSystem = 'FMGC';
        CDUFlightPlanPage._timer = 0;
        mcdu.pageUpdate = () => {
            CDUFlightPlanPage._timer++;
            if (CDUFlightPlanPage._timer >= 100) {
                CDUFlightPlanPage.ShowPage(mcdu, offset);
            }
        };
        const isFlying = Simplane.getAltitudeAboveGround() > 10 ||
            Simplane.getEngineThrottleMode(0) >= ThrottleMode.FLEX_MCT && Simplane.getEngineThrottleMode(1) >= ThrottleMode.FLEX_MCT;
        let originIdentCell = "----";
        if (mcdu.flightPlanManager.getOrigin()) {
            originIdentCell = mcdu.flightPlanManager.getOrigin().ident;
            const runway = mcdu.flightPlanManager.getDepartureRunway();
            if (runway) {
                originIdentCell += Avionics.Utils.formatRunway(runway.designation);
            }
        }
        const utcTime = SimVar.GetGlobalVarValue("ZULU TIME", "seconds");
        let originTimeCell = "----";
        if (mcdu.flightPlanManager.getOrigin()) {
            if (isFlying) {
                originTimeCell = FMCMainDisplay.secondsToUTC(mcdu.flightPlanManager._waypointReachedAt);
            } else {
                originTimeCell = "0000";
                mcdu.flightPlanManager._waypointReachedAt = utcTime;
            }
        }
        let destCell = "----";
        if (mcdu.flightPlanManager.getDestination()) {
            destCell = mcdu.flightPlanManager.getDestination().ident;
            const approachRunway = mcdu.flightPlanManager.getApproachRunway();
            if (approachRunway) {
                destCell += Avionics.Utils.formatRunway(approachRunway.designation);
            }
        }
        let rows = [[""], [""], [""], [""], [""], [""], [""], [""], [""], [""], [""], [""],];
        let rowsCount = 6;
        if (mcdu.flightPlanManager.getCurrentFlightPlanIndex() === 1) {
            rowsCount = 5;
            rows[10] = ["TMPY[color]amber", "TMPY[color]amber"];
            rows[11] = ["*ERASE[color]amber", "INSERT*[color]amber"];
            mcdu.onLeftInput[5] = async () => {
                mcdu.eraseTemporaryFlightPlan(() => {
                    CDUFlightPlanPage.ShowPage(mcdu, 0);
                });
            };
            mcdu.onRightInput[5] = async () => {
                mcdu.insertTemporaryFlightPlan(() => {
                    CDUFlightPlanPage.ShowPage(mcdu, 0);
                });
            };
        }
        const waypointsWithDiscontinuities = [];
        const routeFirstWaypointIndex = 1 + mcdu.flightPlanManager.getDepartureWaypointsCount();
        const routeLastWaypointIndex = mcdu.flightPlanManager.getWaypointsCount() - 2 - mcdu.flightPlanManager.getArrivalWaypointsCount();
        let first = 0;
        if (mcdu.flightPlanManager.isActiveApproach()) {
            first = mcdu.flightPlanManager.getWaypointsCount() - 1;
        } else {
            first = Math.max(0, mcdu.flightPlanManager.getActiveWaypointIndex() - 1);
        }
        if (mcdu.currentFlightPhase <= FlightPhase.FLIGHT_PHASE_TAKEOFF) {
            first = 0;
        }
        for (let i = first; i < mcdu.flightPlanManager.getWaypointsCount(); i++) {
            const prev = waypointsWithDiscontinuities[waypointsWithDiscontinuities.length - 1];
            const wp = mcdu.flightPlanManager.getWaypoint(i);
            if (!prev || (prev.wp && prev.wp.ident != wp.ident)) {
                waypointsWithDiscontinuities.push({ wp: mcdu.flightPlanManager.getWaypoint(i), fpIndex: i });
            }
        }
        const approachWaypoints = mcdu.flightPlanManager.getApproachWaypoints();
        const destination = waypointsWithDiscontinuities.pop();
        for (let i = 0; i < approachWaypoints.length; i++) {
            const prev = waypointsWithDiscontinuities[waypointsWithDiscontinuities.length - 1];
            const wp = approachWaypoints[i];
            if (!prev || (prev.wp && prev.wp.ident != wp.ident)) {
                waypointsWithDiscontinuities.push({
                    wp: wp,
                    fpIndex: -42
                });
            }
        }
        if (destination) {
            waypointsWithDiscontinuities.push(destination);
        }
        if (mcdu.flightPlanManager.decelWaypoint) {
            const idx = waypointsWithDiscontinuities.length > 1 ?
                waypointsWithDiscontinuities.findIndex((e) => e.wp.cumulativeDistanceInFP > mcdu.flightPlanManager.decelWaypoint.cumulativeDistanceInFP) : 0;
            if (idx >= 0 && idx < waypointsWithDiscontinuities.length) {
                waypointsWithDiscontinuities.splice(idx, 0, {
                    wp: mcdu.flightPlanManager.decelWaypoint,
                    fpIndex: -42
                });
            }
        }
        if (waypointsWithDiscontinuities.length === 0) {
            rowsCount = 0;
            originIdentCell = "";
            rows = [
                ["", "SPD/ALT", "TIME"],
                ["PPOS", "---/ ---", "----"],
                [""],
                ["---F-PLN DISCONTINUITY---"],
                [""],
                ["------END OF F-PLN-------"],
                [""],
                ["-----NO ALTN F-PLN-------"],
                [""],
                [""],
                ["DEST", "DIST EFOB", "TIME"],
                ["------", "---- ----", "----"]
            ];
        }
        let iWaypoint = offset;
        let lastAltitudeConstraint = "";
        let lastSpeedConstraint = "";
        const activeIdent = mcdu.flightPlanManager.getActiveWaypointIdent();
        const activeIndex = waypointsWithDiscontinuities.findIndex(w => {
            return w.wp && w.wp.ident === activeIdent;
        });
        for (let i = 0; i < rowsCount; i++) {
            if (waypointsWithDiscontinuities.length > 0) {
                while (iWaypoint >= waypointsWithDiscontinuities.length) {
                    iWaypoint -= waypointsWithDiscontinuities.length;
                }
            }
            const index = iWaypoint;
            iWaypoint++;
            if (index === 0 && first === 0) {
                rows[2 * i] = ["FROM", "SPD/ALT", isFlying ? "UTC" : "TIME"];
                rows[2 * i + 1] = [originIdentCell + "[color]green", "---/ ---[color]green", originTimeCell + "[color]green"];
                mcdu.leftInputDelay[i] = () => {
                    return mcdu.getDelaySwitchPage();
                };
                mcdu.onLeftInput[i] = async (value) => {
                    if (value === "") {
                        CDULateralRevisionPage.ShowPage(mcdu, mcdu.flightPlanManager.getOrigin(), 0);
                    }
                };
            } else if (index === waypointsWithDiscontinuities.length - 1 || (i === rowsCount - 1)) {
                let destTimeCell = "----";
                let destDistCell = "---";
                if (mcdu.flightPlanManager.getDestination()) {
                    destDistCell = mcdu.flightPlanManager.getDestination().liveDistanceTo.toFixed(0);
                    if (isFlying) {
                        destTimeCell = FMCMainDisplay.secondsToUTC(mcdu.flightPlanManager.getDestination().liveUTCTo);
                    } else {
                        destTimeCell = FMCMainDisplay.secondsTohhmm(mcdu.flightPlanManager.getDestination().liveETATo);
                    }
                    mcdu.leftInputDelay[i] = () => {
                        return mcdu.getDelaySwitchPage();
                    };
                    mcdu.onLeftInput[i] = (value) => {
                        if (value === "") {
                            CDULateralRevisionPage.ShowPage(mcdu, mcdu.flightPlanManager.getDestination(), mcdu.flightPlanManager.getWaypointsCount() - 1);
                        } else if (value === FMCMainDisplay.clrValue) {
                        } else if (value.length > 0) {
                            mcdu.insertWaypoint(value, mcdu.flightPlanManager.getWaypointsCount() - 1, () => {
                                CDUFlightPlanPage.ShowPage(mcdu, offset);
                            });
                        }
                    };
                }
                rows[2 * i] = ["DEST", "DIST EFOB", isFlying ? "UTC" : "TIME"];
                rows[2 * i + 1] = [destCell, destDistCell + " ----", destTimeCell];
                i++;
                if (i < rowsCount) {
                    rows[2 * i + 1] = ["------END OF F-PLN-------"];
                }
            } else if (index < waypointsWithDiscontinuities.length - 1) {
                let prevWaypoint;
                let waypoint;
                let fpIndex = 0;
                if (waypointsWithDiscontinuities[index]) {
                    waypoint = waypointsWithDiscontinuities[index].wp;
                    if (waypointsWithDiscontinuities[index - 1]) {
                        prevWaypoint = waypointsWithDiscontinuities[index - 1].wp;
                    }
                    fpIndex = waypointsWithDiscontinuities[index].fpIndex;
                }
                if (!waypoint) {
                    console.error("Should not reach.");
                } else {
                    let timeCell = "----";
                    if (isFlying) {
                        if (isFinite(waypoint.liveUTCTo) || isFinite(mcdu.flightPlanManager._waypointReachedAt)) {
                            timeCell = FMCMainDisplay.secondsToUTC((index >= activeIndex || waypoint.ident === "(DECEL)" ? waypoint.liveUTCTo : mcdu.flightPlanManager._waypointReachedAt)) + "[s-text]";
                        }
                    } else {
                        if (isFinite(waypoint.liveETATo)) {
                            timeCell = FMCMainDisplay.secondsTohhmm(index >= activeIndex || waypoint.ident === "(DECEL)" ? waypoint.liveETATo : 0) + "[s-text]";
                        }
                    }
                    if (fpIndex > mcdu.flightPlanManager.getDepartureWaypointsCount()) {
                        if (fpIndex < mcdu.flightPlanManager.getWaypointsCount() - mcdu.flightPlanManager.getArrivalWaypointsCount()) {
                            if (waypoint.infos.airwayIdentInFP === "") {
                                const prevWaypointWithDiscontinuity = waypointsWithDiscontinuities[index - 1];
                                if (prevWaypointWithDiscontinuity) {
                                    prevWaypoint = prevWaypointWithDiscontinuity.wp;
                                }
                            }
                        }
                    }
                    if (i < rowsCount - 1) { // enough space left before DEST line
                        let airwayName = "";
                        if (prevWaypoint && waypoint) {
                            let airway = undefined;
                            if (prevWaypoint.infos.airwayOut === waypoint.infos.airwayIn) {
                                airway = {name: prevWaypoint.infos.airwayOut };
                            } else if (waypoint.infos.airwayIn && prevWaypoint.infos.airwayOut === undefined) {
                                airway = {name: waypoint.infos.airwayIn };
                            } else {
                                // vanilla Behavior that should not be working this way. (base don pilot feedback)
                                // airway = IntersectionInfo.GetCommonAirway(prevWaypoint, waypoint);
                            }
                            if (airway) {
                                airwayName = airway.name;
                            }
                        }
                        const distance = (waypoint === mcdu.flightPlanManager.getActiveWaypoint() ? waypoint.liveDistanceTo : waypoint.distanceInFP);
                        rows[2 * i] = [airwayName, (index >= activeIndex || waypoint.ident === "(DECEL)" ? distance.toFixed(0) : "")];
                        let speedConstraint = "---";
                        if (waypoint.speedConstraint > 10) {
                            speedConstraint = "{magenta}*{end}" + waypoint.speedConstraint.toFixed(0);
                            if (speedConstraint === lastSpeedConstraint) {
                                speedConstraint = " \" ";
                            } else {
                                lastSpeedConstraint = speedConstraint;
                            }
                        }
                        let altitudeConstraint = "---";
                        let altPrefix = "";
                        const isDepartureWayPoint = routeFirstWaypointIndex > 1 && mcdu.flightPlanManager.getDepartureWaypoints().indexOf(waypointsWithDiscontinuities[index]) !== -1;
                        if (mcdu.transitionAltitude >= 100 && waypoint.legAltitude1 > mcdu.transitionAltitude) {
                            altitudeConstraint = "FL" + (waypoint.legAltitude1 / 100).toFixed(0);
                        } else {
                            altitudeConstraint = waypoint.legAltitude1.toFixed(0);
                        }
                        if (waypoint.legAltitudeDescription !== 0 && waypoint.ident !== "(DECEL)") {
                            altPrefix = "{magenta}*{end}";
                            if (waypoint.legAltitudeDescription === 4) {
                                altitudeConstraint = ((waypoint.legAltitude1 + waypoint.legAltitude2) * 0.5).toFixed(0);
                            }
                        //predict altitude for STAR when constraints are missing
                        } else if (isDepartureWayPoint) {
                            altitudeConstraint = Math.floor(waypoint.cumulativeDistanceInFP * 0.14 * 6076.118 / 10);
                        //waypoint is the first or the last of the actual route
                        } else if ((index === routeFirstWaypointIndex - 1) || (index === routeLastWaypointIndex + 1)) {
                            altitudeConstraint = "FL" + mcdu.cruiseFlightLevel;
                        //waypoint is in between on the route
                        } else if (index <= routeLastWaypointIndex || index >= routeFirstWaypointIndex) {
                            altitudeConstraint = "FL" + mcdu.cruiseFlightLevel;
                        }
                        if (altitudeConstraint === lastAltitudeConstraint) {
                            altitudeConstraint = "  \"  ";
                        } else {
                            lastAltitudeConstraint = altitudeConstraint;
                        }
                        let color = "green";
                        if (mcdu.flightPlanManager.getCurrentFlightPlanIndex() === 1) {
                            color = "yellow";
                        } else if (waypoint === mcdu.flightPlanManager.getActiveWaypoint()) {
                            color = "white";
                        }

                        if (fpIndex !== -42) {
                            mcdu.leftInputDelay[i] = (value) => {
                                if (value === "") {
                                    if (waypoint) {
                                        return mcdu.getDelaySwitchPage();
                                    }
                                }
                                return mcdu.getDelayBasic();
                            };
                            mcdu.onLeftInput[i] = async (value) => {
                                if (value === "") {
                                    if (waypoint) {
                                        CDULateralRevisionPage.ShowPage(mcdu, waypoint, fpIndex);
                                    }
                                } else if (value === FMCMainDisplay.clrValue) {
                                    mcdu.removeWaypoint(fpIndex, () => {
                                        CDUFlightPlanPage.ShowPage(mcdu, offset);
                                    });
                                } else if (value.length > 0) {
                                    mcdu.insertWaypoint(value, fpIndex, () => {
                                        CDUFlightPlanPage.ShowPage(mcdu, offset);
                                    });
                                }
                            };
                            mcdu.rightInputDelay[i] = () => {
                                return mcdu.getDelaySwitchPage();
                            };
                            mcdu.onRightInput[i] = async () => {
                                if (waypoint) {
                                    CDUVerticalRevisionPage.ShowPage(mcdu, waypoint);
                                }
                            };
                        }

                        if (mcdu.activeHold && mcdu.activeHold.has(waypoint.ident)) {
                            const holdRows = [
                                [waypoint.ident + "[color]" + color, speedConstraint + "/" + altitudeConstraint + "[s-text][color]" + color, timeCell + "[color]" + color],
                                ["" , "IMM[color]cyan" , "HOLD"],
                                ["HOLD " + mcdu.activeHold.get(waypoint.ident).turn + "[color]" + color, "EXIT*[color]cyan", "SPD " + mcdu.activeHold.get(waypoint.ident).speed],
                                ["C" + mcdu.activeHold.get(waypoint.ident).course.toFixed(0) + "°"],
                                [waypoint.ident + "[color]" + color, speedConstraint + "/" + altitudeConstraint + "[s-text][color]" + color, timeCell + "[color]" + color]
                            ];

                            mcdu.rightInputDelay[i + 1] = () => {
                                return mcdu.getDelaySwitchPage();
                            };
                            // place the button input on the HOLD line to clear the hold
                            mcdu.onRightInput[i + 1] = async () => {
                                // TODO remove any active waypoints and route to active waypoint
                                mcdu.activeHold = null;
                                CDUFlightPlanPage.ShowPage(mcdu, offset);
                            };

                            for (let j = 0; i < rowsCount - 1; i++) {
                                rows[2 * i + 1] = holdRows[j++];
                                if (i == rowsCount - 2 || j >= holdRows.length) {
                                    break;
                                }

                                rows[2 * i + 2] = holdRows[j++];
                            }
                        } else {
                            rows[2 * i + 1] = [waypoint.ident + "[color]" + color, speedConstraint + "/" + altPrefix + altitudeConstraint + "[s-text][color]" + color, timeCell + "[color]" + color];
                        }
                    } else {
                        let destTimeCell = "----";
                        let destDistCell = "---";
                        if (mcdu.flightPlanManager.getDestination()) {
                            destDistCell = mcdu.flightPlanManager.getDestination().infos.totalDistInFP.toFixed(0);
                            if (isFlying) {
                                destTimeCell = FMCMainDisplay.secondsToUTC(mcdu.flightPlanManager.getDestination().estimatedTimeOfArrivalFP);
                            } else {
                                destTimeCell = FMCMainDisplay.secondsTohhmm(mcdu.flightPlanManager.getDestination().cumulativeEstimatedTimeEnRouteFP);
                            }
                        }
                        rows[2 * i] = ["DEST", "DIST EFOB", isFlying ? "UTC" : "TIME"];
                        rows[2 * i + 1] = [destCell, destDistCell + " ----", destTimeCell];
                        mcdu.leftInputDelay[i] = () => {
                            return mcdu.getDelaySwitchPage();
                        };
                        mcdu.onLeftInput[i] = () => {
                            CDULateralRevisionPage.ShowPage(mcdu, mcdu.flightPlanManager.getDestination(), mcdu.flightPlanManager.getWaypointsCount() - 1);
                        };
                    }
                }
            }
        }
        mcdu.currentFlightPlanWaypointIndex = offset + first;
        const wpCount = mcdu.flightPlanManager.getWaypointsCount() + approachWaypoints.length;
        if (wpCount > 0) {
            while (mcdu.currentFlightPlanWaypointIndex < 0) {
                mcdu.currentFlightPlanWaypointIndex += wpCount;
            }
            while (mcdu.currentFlightPlanWaypointIndex >= wpCount) {
                mcdu.currentFlightPlanWaypointIndex -= wpCount;
            }
        }
        mcdu.setTemplate([
            ["FROM " + originIdentCell],
            ...rows
        ]);
        mcdu.onDown = () => {//on page down decrement the page offset.
            if (offset > 0) {//if page not on top
                offset--;
            } else {//else go to the bottom
                offset = waypointsWithDiscontinuities.length - 1;
            }
            CDUFlightPlanPage.ShowPage(mcdu, offset);
        };
        mcdu.onUp = () => {
            if (offset < waypointsWithDiscontinuities.length - 1) {//if page not on bottom
                offset++;
            } else {//else go on top
                offset = 0;
            }
            CDUFlightPlanPage.ShowPage(mcdu, offset);
        };
    }
}
CDUFlightPlanPage._timer = 0;

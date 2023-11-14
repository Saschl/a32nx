/* eslint-disable jsx-a11y/label-has-associated-control */

import { ClockEvents, FSComponent, Subject, VNode } from '@microsoft/msfs-sdk';

import './fuel_load.scss';
import { AbstractMfdPageProps } from 'instruments/src/MFD/MFD';
import { Footer } from 'instruments/src/MFD/pages/common/Footer';

import { InputField } from 'instruments/src/MFD/pages/common/InputField';
import { CostIndexFormat, PaxNbrFormat, PercentageFormat, TimeHHMMFormat, WeightFormat } from 'instruments/src/MFD/pages/common/DataEntryFormats';
import { Button } from 'instruments/src/MFD/pages/common/Button';
import { maxAltnFuel, maxBlockFuel, maxFinalFuel, maxJtsnGw, maxRteRsvFuel, maxRteRsvFuelPerc, maxTaxiFuel, maxZfw, maxZfwCg, minZfwCg } from 'shared/PerformanceConstants';
import { FmsPage } from 'instruments/src/MFD/pages/common/FmsPage';
import { MfdSimvars } from 'instruments/src/MFD/shared/MFDSimvarPublisher';
import { FmgcFlightPhase } from '@shared/flightphase';

interface MfdFmsFuelLoadProps extends AbstractMfdPageProps {
}

export class MfdFmsFuelLoad extends FmsPage<MfdFmsFuelLoadProps> {
    private grossWeight = Subject.create<number>(null);

    private centerOfGravity = Subject.create<number>(null);

    private fuelOnBoard = Subject.create<number>(null);

    private fuelPlanningIsDisabled = Subject.create<boolean>(true);

    private tripFuelWeight = Subject.create<number>(null);

    private tripFuelTime = Subject.create<number>(null);

    private takeoffWeight = Subject.create<number>(undefined);

    private landingWeight = Subject.create<number>(undefined);

    private destIcao = Subject.create<string>('----');

    private destEta = Subject.create<string>('--:--');

    private destEfob = Subject.create<string>('--.-');

    private altnIcao = Subject.create<string>('----');

    private altnEta = Subject.create<string>('--:--');

    private altnEfob = Subject.create<string>('--.-');

    private extraFuelWeight = Subject.create<number>(null);

    private extraFuelTime = Subject.create<number>(null);

    private enginesWereStarted = Subject.create<boolean>(false);

    private blockLineRef = FSComponent.createRef<HTMLDivElement>();

    protected onNewData() {
        console.time('FUEL_LOAD:onNewData');

        if (this.props.fmService.fmgc.data.routeReserveFuelIsPilotEntered.get() === false) {
            // Calculate Rte Rsv fuel for 5.0% reserve
            this.props.fmService.fmgc.data.routeReserveFuelWeightCalculated.set(undefined);
            this.props.fmService.fmgc.data.routeReserveFuelPercentagePilotEntry.set(undefined);
        }

        if (this.props.fmService.fmgc.data.finalFuelIsPilotEntered.get() === false) {
            // Calculate Rte Rsv fuel for 00:30 time
            this.props.fmService.fmgc.data.finalFuelWeightCalculated.set(6_000); // TODO
        }

        // TODO calculate altn fuel
        this.props.fmService.fmgc.data.alternateFuelCalculated.set(650);

        if (this.loadedFlightPlan.destinationAirport) {
            this.destIcao.set(this.loadedFlightPlan.destinationAirport.ident);

            const destPred = this.props.fmService.guidanceController.vnavDriver.getDestinationPrediction();
            if (destPred) {
                const eta = new Date(Date.now() + destPred.secondsFromPresent * 1000);
                this.destEta.set(`${eta.getHours().toString().padStart(2, '0')}:${eta.getMinutes().toString().padStart(2, '0')}`);
            }
            this.destEfob.set(this.props.fmService.fmgc.getDestEFOB(true).toFixed(1));
        }

        if (this.loadedFlightPlan.alternateDestinationAirport) {
            this.altnIcao.set(this.loadedFlightPlan.alternateDestinationAirport.ident);
        }

        console.timeEnd('FUEL_LOAD:onNewData');
    }

    public onAfterRender(node: VNode): void {
        super.onAfterRender(node);

        const sub = this.props.bus.getSubscriber<ClockEvents & MfdSimvars>();

        this.subs.push(sub.on('realTime').atFrequency(1).handle((_t) => {
            this.landingWeight.set(this.props.fmService.getLandingWeight());
            this.takeoffWeight.set(this.props.fmService.getTakeoffWeight());

            if (this.props.fmService.enginesWereStarted.get() === false) {
                this.grossWeight.set(null);
                this.centerOfGravity.set(null);
                this.fuelOnBoard.set(null);
            } else {
                // GW only displayed after engine start. Value received from FQMS, or falls back to ZFW + FOB
                const gw: number = SimVar.GetSimVarValue('TOTAL WEIGHT', 'pounds') * 0.453592;
                this.grossWeight.set(gw);

                // CG only displayed after engine start. Value received from FQMS, or falls back to value from WBBC
                const cg: number = SimVar.GetSimVarValue('CG PERCENT', 'Percent over 100') * 100;
                this.centerOfGravity.set(cg);

                // FOB only displayed after engine start. Value received from FQMS, or falls back to FOB stored at engine start + fuel used by FADEC
                const fob = SimVar.GetSimVarValue('FUEL TOTAL QUANTITY', 'gallons') * SimVar.GetSimVarValue('FUEL WEIGHT PER GALLON', 'kilograms');
                this.fuelOnBoard.set(fob);
            }

            if (this.activeFlightPhase.get() === FmgcFlightPhase.Preflight) {
                this.tripFuelWeight.set(25_000);
                // EXTRA = BLOCK - TAXI - TRIP - MIN FUEL DEST - RTE RSV
                this.extraFuelWeight.set((this.enginesWereStarted.get() === true ? this.fuelOnBoard.get() : this.props.fmService.fmgc.data.blockFuel.get())
                - this.props.fmService.fmgc.data.taxiFuel.get()
                - this.tripFuelWeight.get()
                - this.props.fmService.fmgc.data.minimumFuelAtDestination.get()
                - this.props.fmService.fmgc.data.routeReserveFuelWeight.get());
            } else {
                // EXTRA = FOB - TRIP - MIN FUEL DEST
                this.extraFuelWeight.set(this.fuelOnBoard.get() - this.tripFuelWeight.get() - this.props.fmService.fmgc.data.minimumFuelAtDestination.get());
            }
        }));

        this.subs.push(this.enginesWereStarted.sub((val) => {
            if (val === true) {
                this.blockLineRef.getOrDefault().style.visibility = 'hidden';
            }
        }, true));
    }

    render(): VNode {
        return (
            <>
                {super.render()}
                {/* begin page content */}
                <div class="mfd-page-container">
                    <div style="display: flex; flex-direction: row; justify-content: space-between; margin: 10px 25px 10px 25px;">
                        <div class="mfd-label-value-container">
                            <span class="mfd-label mfd-spacing-right">GW</span>
                            <span class="mfd-value-green">{this.grossWeight.map((it) => (it ? (it / 1000).toFixed(1) : '---.-'))}</span>
                            <span class="mfd-label-unit mfd-unit-trailing">T</span>
                        </div>
                        <div class="mfd-label-value-container">
                            <span class="mfd-label mfd-spacing-right">CG</span>
                            <span class="mfd-value-green">{this.centerOfGravity.map((it) => (it ? (it).toFixed(1) : '--.-'))}</span>
                            <span class="mfd-label-unit mfd-unit-trailing">%</span>
                        </div>
                        <div class="mfd-label-value-container">
                            <span class="mfd-label mfd-spacing-right">FOB</span>
                            <span class="mfd-value-green">{this.fuelOnBoard.map((it) => (it ? (it / 1000).toFixed(1) : '---.-'))}</span>
                            <span class="mfd-label-unit mfd-unit-trailing">T</span>
                        </div>
                    </div>
                    <div style="display: flex; flex-direction: row; margin-bottom: 15px; align-items: center; ">
                        <div class="mfd-label mfd-spacing-right fuelLoad">
                            ZFW
                        </div>
                        <InputField<number>
                            dataEntryFormat={new WeightFormat(Subject.create(0), Subject.create(maxZfw))}
                            value={this.props.fmService.fmgc.data.zeroFuelWeight}
                            mandatory={Subject.create(true)}
                            inactive={this.enginesWereStarted}
                            canBeCleared={Subject.create(false)}
                            alignText="flex-end"
                            containerStyle="width: 150px;"
                        />
                        <div class="mfd-label mfd-spacing-right fuelLoad">
                            ZFWCG
                        </div>
                        <InputField<number>
                            dataEntryFormat={new PercentageFormat(Subject.create(minZfwCg), Subject.create(maxZfwCg))}
                            value={this.props.fmService.fmgc.data.zeroFuelWeightCenterOfGravity}
                            mandatory={Subject.create(true)}
                            inactive={this.enginesWereStarted}
                            canBeCleared={Subject.create(false)}
                            alignText="center"
                            containerStyle="width: 125px;"
                        />
                    </div>
                    <div ref={this.blockLineRef} class="mfd-fms-fuel-load-block-line">
                        <div class="mfd-label mfd-spacing-right fuelLoad">
                            BLOCK
                        </div>
                        <InputField<number>
                            dataEntryFormat={new WeightFormat(Subject.create(0), Subject.create(maxBlockFuel))}
                            value={this.props.fmService.fmgc.data.blockFuel}
                            mandatory={Subject.create(true)}
                            alignText="flex-end"
                            containerStyle="width: 150px;"
                        />
                        <div style="display: flex; flex: 1; justify-content: center;">
                            <Button
                                disabled={this.fuelPlanningIsDisabled}
                                label={Subject.create(
                                    <div style="display: flex; flex-direction: row;">
                                        <span style="text-align: center; vertical-align: center; margin-right: 10px;">
                                            FUEL
                                            <br />
                                            PLANNING
                                        </span>
                                        <span style="display: flex; align-items: center; justify-content: center;">*</span>
                                    </div>,
                                )}
                                onClick={() => console.log('FUEL PLANNING')}
                                buttonStyle="padding-right: 2px;"
                            />
                        </div>
                    </div>
                    <div class="mfd-fms-fuel-load-middle-grid">
                        <div class="mfd-label mfd-spacing-right middleGrid">
                            TAXI
                        </div>
                        <div style="margin-bottom: 20px;">
                            <InputField<number>
                                dataEntryFormat={new WeightFormat(Subject.create(0), Subject.create(maxTaxiFuel))}
                                value={this.props.fmService.fmgc.data.taxiFuel}
                                inactive={this.activeFlightPhase.map((it) => it >= FmgcFlightPhase.Takeoff)}
                                alignText="flex-end"
                                containerStyle="width: 150px;"
                            />
                        </div>
                        <div />
                        <div class="mfd-label mfd-spacing-right middleGrid">
                            PAX NBR
                        </div>
                        <div style="margin-bottom: 20px;">
                            <InputField<number>
                                dataEntryFormat={new PaxNbrFormat()}
                                value={this.props.fmService.fmgc.data.paxNumber}
                                mandatory={Subject.create(true)}
                                alignText="center"
                                containerStyle="width: 75px;"
                            />
                        </div>
                        <div class="mfd-label mfd-spacing-right middleGrid">
                            TRIP
                        </div>
                        <div class="mfd-label-value-container" style="justify-content: flex-end; margin-bottom: 20px;">
                            <span class="mfd-value-green">{this.tripFuelWeight.map((it) => (it ? (it / 1000).toFixed(1) : '---.-'))}</span>
                            <span class="mfd-label-unit mfd-unit-trailing">T</span>
                        </div>
                        <div style="display: flex; justify-content: center; margin-bottom: 20px;">
                            <span class="mfd-value-green">{this.tripFuelTime.map((it) => (new TimeHHMMFormat()).format(it))}</span>
                        </div>
                        <div class="mfd-label mfd-spacing-right middleGrid">
                            CI
                        </div>
                        <div style="margin-bottom: 20px;">
                            <InputField<number>
                                dataEntryFormat={new CostIndexFormat()}
                                value={this.props.fmService.fmgc.data.costIndex}
                                mandatory={Subject.create(true)}
                                disabled={this.activeFlightPhase.map((it) => it >= FmgcFlightPhase.Descent)}
                                alignText="center"
                                containerStyle="width: 75px;"
                            />
                        </div>
                        <div class="mfd-label mfd-spacing-right middleGrid">
                            RTE RSV
                        </div>
                        <div style="margin-bottom: 20px;">
                            <InputField<number>
                                disabled={Subject.create(true)}
                                dataEntryFormat={new WeightFormat(Subject.create(0), Subject.create(maxRteRsvFuel))}
                                dataHandlerDuringValidation={async (v) => this.props.fmService.fmgc.data.routeReserveFuelWeightPilotEntry.set(v || undefined)}
                                enteredByPilot={this.props.fmService.fmgc.data.routeReserveFuelIsPilotEntered}
                                value={this.props.fmService.fmgc.data.routeReserveFuelWeight}
                                inactive={this.activeFlightPhase.map((it) => it >= FmgcFlightPhase.Takeoff)}
                                onModified={() => {}} // already handled during data validation
                                alignText="flex-end"
                                containerStyle="width: 150px;"
                            />
                        </div>
                        <div style="margin-bottom: 20px; margin-left: 5px">
                            <InputField<number>
                                disabled={Subject.create(true)}
                                dataEntryFormat={new PercentageFormat(Subject.create(0), Subject.create(maxRteRsvFuelPerc))}
                                dataHandlerDuringValidation={async (v) => this.props.fmService.fmgc.data.routeReserveFuelPercentagePilotEntry.set(v)}
                                enteredByPilot={this.props.fmService.fmgc.data.routeReserveFuelIsPilotEntered}
                                value={this.props.fmService.fmgc.data.routeReserveFuelPercentage}
                                inactive={this.activeFlightPhase.map((it) => it >= FmgcFlightPhase.Takeoff)}
                                onModified={() => {}} // already handled during data validation
                                alignText="center"
                                containerStyle="width: 120px;"
                            />
                        </div>
                        <div class="mfd-label mfd-spacing-right middleGrid">
                            JTSN GW
                        </div>
                        <div style="margin-bottom: 20px;">
                            <InputField<number>
                                dataEntryFormat={new WeightFormat(Subject.create(0), Subject.create(maxJtsnGw))}
                                value={this.props.fmService.fmgc.data.jettisonGrossWeight}
                                alignText="flex-end"
                                containerStyle="width: 150px;"
                            />
                        </div>
                        <div class="mfd-label mfd-spacing-right middleGrid">
                            ALTN
                        </div>
                        <div style="margin-bottom: 20px;">
                            <InputField<number>
                                dataEntryFormat={new WeightFormat(Subject.create(0), Subject.create(maxAltnFuel))}
                                dataHandlerDuringValidation={async (v) => this.props.fmService.fmgc.data.alternateFuelPilotEntry.set(v)}
                                enteredByPilot={this.props.fmService.fmgc.data.alternateFuelIsPilotEntered}
                                value={this.props.fmService.fmgc.data.alternateFuel}
                                onModified={() => {}} // already handled during data validation
                                alignText="flex-end"
                                containerStyle="width: 150px;"
                            />
                        </div>
                        <div style="display: flex; justify-content: center; margin-bottom: 20px;">
                            <span class="mfd-value-green">--:--</span>
                        </div>
                        <div class="mfd-label mfd-spacing-right middleGrid">
                            TOW
                        </div>
                        <div class="mfd-label-value-container" style="justify-content: flex-end; margin-bottom: 20px;">
                            <span class="mfd-value-green">{this.takeoffWeight.map((it) => (it ? (it / 1000).toFixed(1) : '---.-'))}</span>
                            <span class="mfd-label-unit mfd-unit-trailing">T</span>
                        </div>
                        <div class="mfd-label mfd-spacing-right middleGrid">
                            FINAL
                        </div>
                        <div style="margin-bottom: 20px;">
                            <InputField<number>
                                dataEntryFormat={new WeightFormat(Subject.create(0), Subject.create(maxFinalFuel))}
                                dataHandlerDuringValidation={async (v) => {
                                    this.props.fmService.fmgc.data.finalFuelWeightPilotEntry.set(v);
                                    this.props.fmService.fmgc.data.finalFuelTimePilotEntry.set(v / 200); // assuming 200kg fuel burn per minute FIXME
                                }}
                                enteredByPilot={this.props.fmService.fmgc.data.finalFuelIsPilotEntered}
                                value={this.props.fmService.fmgc.data.finalFuelWeight}
                                onModified={() => {}} // already handled during data validation
                                alignText="flex-end"
                                containerStyle="width: 150px;"
                            />
                        </div>
                        <div style="margin-bottom: 20px; margin-left: 5px;">
                            <InputField<number>
                                dataEntryFormat={new TimeHHMMFormat()}
                                dataHandlerDuringValidation={async (v) => {
                                    this.props.fmService.fmgc.data.finalFuelTimePilotEntry.set(v);
                                    this.props.fmService.fmgc.data.finalFuelWeightPilotEntry.set(v * 200); // assuming 200kg fuel burn per minute FIXME
                                }}
                                enteredByPilot={this.props.fmService.fmgc.data.finalFuelIsPilotEntered}
                                value={this.props.fmService.fmgc.data.finalFuelTime}
                                onModified={() => {}} // already handled during data validation
                                alignText="center"
                                containerStyle="width: 120px;"
                            />
                        </div>
                        <div class="mfd-label mfd-spacing-right middleGrid">
                            LW
                        </div>
                        <div class="mfd-label-value-container" style="justify-content: flex-end; margin-bottom: 20px;">
                            <span class="mfd-value-green">{this.landingWeight.map((it) => (it ? (it / 1000).toFixed(1) : '---.-'))}</span>
                            <span class="mfd-label-unit mfd-unit-trailing">T</span>
                        </div>
                    </div>
                    <div style="flex: 1; display: flex; flex-direction: row; margin-top: 25px;">
                        <div style="width: 62.5%">
                            <div style="display: grid; grid-template-columns: auto auto auto auto;">
                                <div class="mfd-fms-fuel-load-dest-grid-top-cell" />
                                <div class="mfd-fms-fuel-load-dest-grid-top-cell" />
                                <div class="mfd-label mfd-fms-fuel-load-dest-grid-top-cell">
                                    UTC
                                </div>
                                <div class="mfd-label mfd-fms-fuel-load-dest-grid-top-cell">
                                    EFOB
                                </div>
                                <div class="mfd-label mfd-fms-fuel-load-dest-grid-middle-cell">
                                    DEST
                                </div>
                                <div class="mfd-label bigger green mfd-fms-fuel-load-dest-grid-middle-cell">
                                    {this.destIcao}
                                </div>
                                <div class="mfd-label bigger green mfd-fms-fuel-load-dest-grid-middle-cell">
                                    {this.destEta}
                                </div>
                                <div class="mfd-label-value-container mfd-fms-fuel-load-dest-grid-efob-cell">
                                    <span class="mfd-value-green">{this.destEfob}</span>
                                    <span class="mfd-label-unit mfd-unit-trailing">T</span>
                                </div>
                                <div class="mfd-label" style="text-align: center; align-self: center;">
                                    ALTN
                                </div>
                                <div class="mfd-label bigger green" style="text-align: center; align-self: center;">
                                    {this.altnIcao}
                                </div>
                                <div class="mfd-label bigger green" style="text-align: center; align-self: center;">
                                    {this.altnEta}
                                </div>
                                <div class="mfd-label-value-container mfd-fms-fuel-load-dest-grid-efob-cell">
                                    <span class="mfd-value-green">{this.altnEfob}</span>
                                    <span class="mfd-label-unit mfd-unit-trailing">T</span>
                                </div>
                            </div>
                        </div>
                        <div style="flex: 1; flex-direction: column; justify-content: center; align-items: center;">
                            <div class="mfd-label" style="margin-bottom: 20px; text-align: center;">MIN FUEL AT DEST</div>
                            <div style="margin-bottom: 30px; display: flex; justify-content: center;">
                                <InputField<number>
                                    dataEntryFormat={new WeightFormat()}
                                    dataHandlerDuringValidation={async (v) => this.props.fmService.fmgc.data.minimumFuelAtDestinationPilotEntry.set(v)}
                                    enteredByPilot={this.props.fmService.fmgc.data.minimumFuelAtDestinationIsPilotEntered}
                                    value={this.props.fmService.fmgc.data.minimumFuelAtDestination}
                                    onModified={() => {}}
                                    alignText="flex-end"
                                    containerStyle="width: 150px;"
                                />
                            </div>
                            <div class="mfd-label" style="margin-bottom: 5px; text-align: center;">EXTRA</div>
                            <div style="display: flex; flex-direction: row; justify-content: center; align-items: center;">
                                <div class="mfd-label-value-container" style="margin-right: 20px;">
                                    <span class="mfd-value-green">{this.extraFuelWeight.map((it) => (it ? (it / 1000).toFixed(1) : '--.-'))}</span>
                                    <span class="mfd-label-unit mfd-unit-trailing">T</span>
                                </div>
                                <span class="mfd-value-green">{this.extraFuelTime.map((it) => (new TimeHHMMFormat()).format(it))}</span>
                            </div>
                        </div>
                    </div>
                    <div style="flex-grow: 1;" />
                    {/* fill space vertically */}
                    <div style="width: 150px;">
                        <Button label="RETURN" onClick={() => this.props.uiService.navigateTo('back')} buttonStyle="margin-right: 5px;" />
                    </div>

                    {/* end page content */}
                </div>
                <Footer bus={this.props.bus} uiService={this.props.uiService} fmService={this.props.fmService} />
            </>
        );
    }
}

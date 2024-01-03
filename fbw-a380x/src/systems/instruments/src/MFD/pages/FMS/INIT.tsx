/* eslint-disable jsx-a11y/label-has-associated-control */

import { FSComponent, MappedSubject, Subject, Subscribable, VNode } from '@microsoft/msfs-sdk';

import './init.scss';
import { AbstractMfdPageProps } from 'instruments/src/MFD/MFD';
import { Footer } from 'instruments/src/MFD/pages/common/Footer';
import { InputField } from 'instruments/src/MFD/pages/common/InputField';
import { AirportFormat, CostIndexFormat, CrzTempFormat, FlightLevelFormat, LongAlphanumericFormat, TripWindFormat, TropoFormat } from 'instruments/src/MFD/pages/common/DataEntryFormats';
import { Button, ButtonMenuItem } from 'instruments/src/MFD/pages/common/Button';
import { maxCertifiedAlt } from '@shared/PerformanceConstants';
import { FmsPage } from 'instruments/src/MFD/pages/common/FmsPage';
import { NXDataStore, Units } from '@flybywiresim/fbw-sdk';
import { SimBriefUplinkAdapter } from '@fmgc/flightplanning/new/uplink/SimBriefUplinkAdapter';
import { FmgcFlightPhase } from '@shared/flightphase';
import { NXFictionalMessages } from 'instruments/src/MFD/pages/FMS/legacy/NXSystemMessages';
import { ISimbriefData } from '../../../../../../../../fbw-a32nx/src/systems/instruments/src/EFB/Apis/Simbrief';

interface MfdFmsInitProps extends AbstractMfdPageProps {
}

export class MfdFmsInit extends FmsPage<MfdFmsInitProps> {
    private simBriefOfp: ISimbriefData;

    private cpnyFplnButtonLabel: Subscribable<VNode> = this.props.fmService.fmgc.data.cpnyFplnAvailable.map((it) => {
        if (it === false) {
            return (
                <span>
                    CPNY F-PLN
                    <br />
                    REQUEST
                </span>
            );
        }
        return (
            <span>
                RECEIVED
                <br />
                CPNY F-PLN
            </span>
        );
    })

    private cpnyFplnButtonMenuItems: Subscribable<ButtonMenuItem[]> = this.props.fmService.fmgc.data.cpnyFplnAvailable.map((it) => (it ? [
        { label: 'INSERT*', action: () => this.insertCpnyFpln() },
        {
            label: 'CLEAR*',
            action: () => {
                this.props.fmService.flightPlanService.uplinkDelete();
                this.props.fmService.fmgc.data.cpnyFplnAvailable.set(false);
            },
        }] : []));

    private fromIcao = Subject.create<string>(null);

    private fromIcaoDisabled = Subject.create<boolean>(false);

    private toIcao = Subject.create<string>(null);

    private altnIcao = Subject.create<string>(null);

    private altnDisabled = MappedSubject.create(([toIcao, fromIcao]) => !toIcao || !fromIcao, this.fromIcao, this.toIcao);

    private cpnyRte = Subject.create<string>(null); // FIXME not found

    private altnRte = Subject.create<string>(null); // FIXME not found

    private crzFl = Subject.create<number>(null);

    private crzTemp = Subject.create<number>(null); // FIXME missing

    // private crzTempIsDisabled = !crzTemp;
    private crzTempIsDisabled = this.crzFl.map((crzFl) => !crzFl);

    private costIndex = Subject.create<number>(null);

    private costIndexDisabled = MappedSubject.create(([toIcao, fromIcao, flightPhase]) => !toIcao || !fromIcao || flightPhase >= FmgcFlightPhase.Descent,
        this.fromIcao,
        this.toIcao,
        this.activeFlightPhase);

    private tripWindDisabled = MappedSubject.create(([toIcao, fromIcao]) => !toIcao || !fromIcao, this.fromIcao, this.toIcao);

    private cpnyRteMandatory = MappedSubject.create(([toIcao, fromIcao]) => !toIcao || !fromIcao, this.fromIcao, this.toIcao);

    private departureButtonDisabled = MappedSubject.create(([toIcao, fromIcao]) => !toIcao || !fromIcao, this.fromIcao, this.toIcao);

    public onAfterRender(node: VNode): void {
        super.onAfterRender(node);
    }

    protected onNewData() {
        console.time('INIT:onNewData');

        this.props.fmService.fmgc.data.cpnyFplnAvailable.set(this.props.fmService.flightPlanService.hasUplink && this.props.fmService.flightPlanService.uplink.legCount > 0);

        // Update internal subjects for display purposes or input fields
        if (this.loadedFlightPlan.originAirport) {
            this.fromIcao.set(this.loadedFlightPlan.originAirport.ident);
        }

        if (this.loadedFlightPlan.destinationAirport) {
            this.toIcao.set(this.loadedFlightPlan.destinationAirport.ident);
        }

        if (this.loadedFlightPlan.alternateDestinationAirport) {
            this.altnIcao.set(this.loadedFlightPlan.alternateDestinationAirport.ident);
        } else {
            this.altnIcao.set((this.loadedFlightPlan.originAirport && this.loadedFlightPlan.destinationAirport) ? 'NONE' : '');
        }

        if (this.loadedFlightPlan.performanceData.cruiseFlightLevel) {
            this.crzFl.set(this.loadedFlightPlan.performanceData.cruiseFlightLevel);
        }

        if (this.loadedFlightPlan.performanceData.costIndex) {
            this.costIndex.set(this.loadedFlightPlan.performanceData.costIndex);
        }

        // Disable or enable fields

        // Set some empty fields with pre-defined values
        if (this.fromIcao.get() && this.toIcao.get()) {
            if (!this.cpnyRte.get()) {
                this.cpnyRte.set('NONE');
            }

            if (!this.altnRte.get()) {
                this.altnRte.set('NONE');
            }
        }

        console.timeEnd('INIT:onNewData');
    }

    private async cpnyFplnRequest() {
        const navigraphUsername = NXDataStore.get('NAVIGRAPH_USERNAME', '');
        const overrideSimBriefUserID = NXDataStore.get('CONFIG_OVERRIDE_SIMBRIEF_USERID', '');

        if (!navigraphUsername && !overrideSimBriefUserID) {
            this.props.fmService.mfd.addMessageToQueue(NXFictionalMessages.noNavigraphUser);
            throw new Error('No Navigraph username provided');
        }

        this.simBriefOfp = await SimBriefUplinkAdapter.downloadOfpForUserID(navigraphUsername, overrideSimBriefUserID);

        SimBriefUplinkAdapter.uplinkFlightPlanFromSimbrief(
            this.props.fmService.mfd,
            this.props.fmService.flightPlanService,
            this.simBriefOfp,
            { doUplinkProcedures: false },
        );
    }

    private async insertCpnyFpln() {
        this.props.fmService.flightPlanService.uplinkInsert();
        this.props.fmService.fmgc.data.atcCallsign.set(this.simBriefOfp.callsign);
        this.props.fmService.fmgc.data.blockFuel.set(this.simBriefOfp.units === 'kgs' ? this.simBriefOfp.fuel.planRamp : Units.poundToKilogram(this.simBriefOfp.fuel.planRamp));
        this.props.fmService.fmgc.data.zeroFuelWeight.set(this.simBriefOfp.units === 'kgs'
            ? Number(this.simBriefOfp.weights.estZeroFuelWeight)
            : Units.poundToKilogram(Number(this.simBriefOfp.weights.estZeroFuelWeight)));
        this.props.fmService.fmgc.data.taxiFuel.set(this.simBriefOfp.units === 'kgs' ? this.simBriefOfp.fuel.taxi : Units.poundToKilogram(this.simBriefOfp.fuel.taxi));
        this.props.fmService.fmgc.data.alternateFuelPilotEntry.set(this.simBriefOfp.units === 'kgs' ? this.simBriefOfp.alternate.burn : Units.poundToKilogram(this.simBriefOfp.alternate.burn));
        this.props.fmService.fmgc.data.finalFuelWeightPilotEntry.set(this.simBriefOfp.units === 'kgs' ? this.simBriefOfp.fuel.reserve : Units.poundToKilogram(this.simBriefOfp.fuel.reserve));
        this.props.fmService.fmgc.data.paxNumber.set(Number(this.simBriefOfp.weights.passengerCount));
        this.props.fmService.fmgc.data.tropopausePilotEntry.set(Number(this.simBriefOfp.averageTropopause));

        this.props.fmService.acInterface.setCruiseFl(this.simBriefOfp.cruiseAltitude / 100);

        this.props.fmService.fmgc.data.cpnyFplnAvailable.set(false);
    }

    render(): VNode {
        return (
            <>
                {super.render()}
                {/* begin page content */}
                <div class="mfd-page-container">
                    <div class="mfd-fms-init-line">
                        <div class="mfd-label init-input-field">FLT NBR</div>
                        <InputField<string>
                            dataEntryFormat={new LongAlphanumericFormat()}
                            mandatory={Subject.create(true)}
                            value={this.props.fmService.fmgc.data.atcCallsign}
                            containerStyle="width: 200px; margin-right: 5px;"
                            alignText="center"
                            errorHandler={(e) => this.props.fmService.mfd.showFmsErrorMessage(e)}
                        />
                        <Button
                            label="ACFT STATUS"
                            onClick={() => this.props.uiService.navigateTo('fms/data/status')}
                            buttonStyle="margin-right: 10px; width: 200px;"
                        />
                        <div style="flex-grow: 1" />
                        <Button
                            label={this.cpnyFplnButtonLabel}
                            disabled={this.props.fmService.fmgc.data.cpnyFplnUplinkInProgress}
                            onClick={() => (this.props.fmService.fmgc.data.cpnyFplnAvailable.get() ? {} : this.cpnyFplnRequest())}
                            buttonStyle="width: 175px;"
                            idPrefix="fplnreq"
                            menuItems={this.cpnyFplnButtonMenuItems}
                            showArrow={false}
                        />
                    </div>
                    <div class="mfd-fms-init-line second-line">
                        <div class="mfd-label init-input-field">FROM</div>
                        <InputField<string>
                            dataEntryFormat={new AirportFormat()}
                            dataHandlerDuringValidation={async (v) => {
                                this.fromIcao.set(v);
                                if (v && this.toIcao.get()) {
                                    await this.props.fmService.flightPlanService.newCityPair(v, this.toIcao.get(), this.altnIcao.get());
                                }
                            }}
                            mandatory={Subject.create(true)}
                            canBeCleared={Subject.create(false)}
                            value={this.fromIcao}
                            alignText="center"
                            disabled={this.fromIcaoDisabled}
                            errorHandler={(e) => this.props.fmService.mfd.showFmsErrorMessage(e)}
                        />
                        <div class="mfd-label init-space-lr">TO</div>
                        <InputField<string>
                            dataEntryFormat={new AirportFormat()}
                            dataHandlerDuringValidation={async (v) => {
                                this.toIcao.set(v);
                                if (this.fromIcao.get() !== undefined && v) {
                                    await this.props.fmService.flightPlanService.newCityPair(this.fromIcao.get(), v, this.altnIcao.get());
                                }
                            }}
                            mandatory={Subject.create(true)}
                            canBeCleared={Subject.create(false)}
                            value={this.toIcao}
                            alignText="center"
                            errorHandler={(e) => this.props.fmService.mfd.showFmsErrorMessage(e)}
                        />
                        <div class="mfd-label init-space-lr">ALTN</div>
                        <InputField<string>
                            dataEntryFormat={new AirportFormat()}
                            dataHandlerDuringValidation={async (v) => {
                                this.altnIcao.set(v);
                                await this.props.fmService.flightPlanService.setAlternate(v);
                            }}
                            mandatory={Subject.create(true)}
                            disabled={this.altnDisabled}
                            value={this.altnIcao}
                            alignText="center"
                            errorHandler={(e) => this.props.fmService.mfd.showFmsErrorMessage(e)}
                        />
                    </div>
                    <div class="mfd-fms-init-line">
                        <div class="mfd-label init-input-field">CPNY RTE</div>
                        <InputField<string>
                            dataEntryFormat={new LongAlphanumericFormat()}
                            mandatory={this.cpnyRteMandatory}
                            canBeCleared={Subject.create(false)}
                            value={this.cpnyRte}
                            containerStyle="width: 200px; margin-right: 5px;"
                            alignText="center"
                            disabled={Subject.create(true)} // TODO
                            errorHandler={(e) => this.props.fmService.mfd.showFmsErrorMessage(e)}
                        />
                        <Button disabled={Subject.create(true)} label="RTE SEL" onClick={() => console.log('RTE SEL')} buttonStyle="margin-right: 10px; width: 200px;" />
                    </div>
                    <div class="mfd-fms-init-line altn-rte">
                        <div class="mfd-label init-input-field">ALTN RTE</div>
                        <InputField<string>
                            dataEntryFormat={new LongAlphanumericFormat()}
                            mandatory={Subject.create(false)}
                            disabled={Subject.create(true)} // TODO
                            canBeCleared={Subject.create(false)}
                            value={this.altnRte}
                            containerStyle="width: 200px; margin-right: 5px;"
                            alignText="center"
                            errorHandler={(e) => this.props.fmService.mfd.showFmsErrorMessage(e)}
                        />
                        <Button
                            label="ALTN RTE SEL"
                            disabled={Subject.create(true /* this.altnDisabled */)}
                            onClick={() => console.log('ALTN RTE SEL')}
                            buttonStyle="margin-right: 10px; width: 200px;"
                        />
                    </div>
                    <div class="mfd-fms-init-line">
                        <div class="mfd-label init-input-field">CRZ FL</div>
                        <InputField<number>
                            dataEntryFormat={new FlightLevelFormat(Subject.create(0), Subject.create(maxCertifiedAlt / 100))}
                            dataHandlerDuringValidation={async (v) => this.props.fmService.acInterface.setCruiseFl(v)}
                            mandatory={Subject.create(true)}
                            disabled={this.altnDisabled}
                            canBeCleared={Subject.create(false)}
                            value={this.crzFl}
                            containerStyle="margin-right: 25px;"
                            errorHandler={(e) => this.props.fmService.mfd.showFmsErrorMessage(e)}
                        />
                        <div class="mfd-label init-input-field" style="width: auto;">CRZ TEMP</div>
                        <InputField<number>
                            dataEntryFormat={new CrzTempFormat()}
                            mandatory={Subject.create(false)}
                            disabled={Subject.create(true)} // TODO
                            value={this.crzTemp}
                            containerStyle="width: 110px; justify-content: flex-end;"
                            alignText="center"
                            errorHandler={(e) => this.props.fmService.mfd.showFmsErrorMessage(e)}
                        />
                    </div>
                    <div class="mfd-fms-init-line" style="margin-top: 10px;">
                        <div class="mfd-label init-input-field">CI</div>
                        <InputField<number>
                            dataEntryFormat={new CostIndexFormat()}
                            dataHandlerDuringValidation={async (v) => {
                                this.loadedFlightPlan.setPerformanceData('costIndex', v || undefined);
                            }}
                            mandatory={Subject.create(true)}
                            disabled={this.costIndexDisabled}
                            value={this.costIndex}
                            containerStyle="width: 70px; margin-right: 90px; justify-content: center;"
                            alignText="center"
                            errorHandler={(e) => this.props.fmService.mfd.showFmsErrorMessage(e)}
                        />
                        <div class="mfd-label init-input-field" style="width: auto;">TROPO</div>
                        <InputField<number>
                            dataEntryFormat={new TropoFormat()}
                            dataHandlerDuringValidation={async (v) => this.props.fmService.fmgc.data.tropopausePilotEntry.set(v)}
                            mandatory={Subject.create(false)}
                            enteredByPilot={this.props.fmService.fmgc.data.tropopauseIsPilotEntered}
                            value={this.props.fmService.fmgc.data.tropopause}
                            onModified={() => { }}
                            alignText="flex-end"
                            errorHandler={(e) => this.props.fmService.mfd.showFmsErrorMessage(e)}
                        />
                    </div>
                    <div class="mfd-fms-init-line trip-wind">
                        <div class="mfd-label init-input-field" style="margin-top: 90px;">TRIP WIND</div>
                        <InputField<number>
                            dataEntryFormat={new TripWindFormat()}
                            mandatory={Subject.create(false)}
                            disabled={this.tripWindDisabled} // TODO
                            value={this.props.fmService.fmgc.data.tripWind}
                            containerStyle="width: 125px; margin-right: 80px; margin-top: 90px;"
                            alignText="center"
                            errorHandler={(e) => this.props.fmService.mfd.showFmsErrorMessage(e)}
                        />
                        <Button disabled={Subject.create(true)} label="WIND" onClick={() => console.log('WIND')} buttonStyle="margin-right: 10px; margin-top: 90px;" />
                        <div style="flex-grow: 1" />
                        <Button
                            disabled={Subject.create(true)}
                            label="CPNY WIND<br />REQUEST"
                            onClick={() => console.log('CPNY WIND REQUEST')}
                            buttonStyle="margin-right: 10px; justify-self: flex-end; width: 175px;"
                        />
                    </div>
                    <Button label="IRS" onClick={() => this.props.uiService.navigateTo('fms/position/irs')} buttonStyle="width: 160px; margin-left: 150px; margin-bottom: 10px;" />
                    <div style={`display: ${this.props.uiService.activeUri.get().category === 'active' ? 'flex' : 'none'}; flex-direction: row;`}>
                        <Button
                            label="DEPARTURE"
                            disabled={this.departureButtonDisabled}
                            onClick={() => this.props.uiService.navigateTo(`fms/${this.props.uiService.activeUri.get().category}/f-pln-departure`)}
                            buttonStyle="width: 160px; margin-left: 150px; margin-bottom: 10px;"
                        />
                        <Button
                            disabled={Subject.create(true)}
                            label="RTE SUMMARY"
                            onClick={() => this.props.uiService.navigateTo('fms/data/route')}
                            buttonStyle="margin-left: 50px; margin-bottom: 10px;"
                        />
                    </div>
                    <Button
                        label="NAVAIDS"
                        onClick={() => this.props.uiService.navigateTo('fms/position/navaids')}
                        buttonStyle="width: 160px; margin-left: 150px; margin-bottom: 10px;"
                    />
                    <Button
                        label="FUEL&LOAD"
                        onClick={() => this.props.uiService.navigateTo(`fms/${this.props.uiService.activeUri.get().category}/fuel-load`)}
                        buttonStyle="width: 160px; margin-left: 150px; margin-bottom: 10px;"
                    />
                    <div style="display: flex; flex-direction: row;">
                        <Button
                            label="T.O. PERF"
                            onClick={() => this.props.uiService.navigateTo(`fms/${this.props.uiService.activeUri.get().category}/perf/to`)}
                            buttonStyle="width: 160px; margin-left: 150px; margin-bottom: 10px; height: 40px;"
                        />
                        <div style="flex-grow: 1" />
                        <Button
                            disabled={Subject.create(true)}
                            label="CPNY T.O.<br />REQUEST"
                            onClick={() => console.log('CPNY T.O. REQUEST')}
                            buttonStyle="margin-right: 10px; justify-self: flex-end; width: 175px;"
                        />
                    </div>
                    {/* end page content */}
                </div>
                <Footer bus={this.props.bus} uiService={this.props.uiService} fmService={this.props.fmService} />
            </>
        );
    }
}

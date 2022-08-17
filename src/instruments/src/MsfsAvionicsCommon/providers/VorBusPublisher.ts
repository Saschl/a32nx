import { EventBus, SimVarPublisher, SimVarValueType } from 'msfssdk';
import { TuningMode } from '@fmgc/radionav';

export interface VorSimVars {
    nav1Ident: string,
    nav1Frequency: number,
    nav1HasDme: boolean,
    nav1DmeDistance: NauticalMiles,
    nav1RelativeBearing: Degrees,
    nav1Obs: Degrees,
    nav1RadialError: Degrees,
    nav1Available: boolean,
    nav1TuningMode: TuningMode,

    nav2Ident: string,
    nav2Frequency: number,
    nav2HasDme: boolean,
    nav2DmeDistance: NauticalMiles,
    nav2RelativeBearing: Degrees,
    nav2Obs: Degrees,
    nav2RadialError: Degrees,
    nav2Available: boolean,
    nav2TuningMode: TuningMode,
}

export class VorBusPublisher extends SimVarPublisher<VorSimVars> {
    constructor(bus: EventBus) {
        super(new Map([
            ['nav1Ident', { name: 'NAV IDENT:1', type: SimVarValueType.String }],
            ['nav1Frequency', { name: 'NAV ACTIVE FREQUENCY:1', type: SimVarValueType.MHz }],
            ['nav1HasDme', { name: 'NAV HAS DME:1', type: SimVarValueType.Bool }],
            ['nav1DmeDistance', { name: 'NAV DME:1', type: SimVarValueType.NM }],
            ['nav1RelativeBearing', { name: 'NAV RELATIVE BEARING TO STATION:1', type: SimVarValueType.Degree }],
            ['nav1Obs', { name: 'NAV OBS:1', type: SimVarValueType.Degree }],
            ['nav1RadialError', { name: 'NAV RADIAL ERROR:1', type: SimVarValueType.Degree }],
            ['nav1Available', { name: 'NAV HAS NAV:1', type: SimVarValueType.Bool }],
            ['nav1TuningMode', { name: 'L:A32NX_FMGC_RADIONAV_1_TUNING_MODE', type: SimVarValueType.Enum }],

            ['nav2Ident', { name: 'NAV IDENT:2', type: SimVarValueType.String }],
            ['nav2Frequency', { name: 'NAV ACTIVE FREQUENCY:2', type: SimVarValueType.MHz }],
            ['nav2HasDme', { name: 'NAV HAS DME:2', type: SimVarValueType.Bool }],
            ['nav2DmeDistance', { name: 'NAV DME:2', type: SimVarValueType.NM }],
            ['nav2RelativeBearing', { name: 'NAV RELATIVE BEARING TO STATION:2', type: SimVarValueType.Degree }],
            ['nav2Obs', { name: 'NAV OBS:2', type: SimVarValueType.Degree }],
            ['nav2RadialError', { name: 'NAV RADIAL ERROR:2', type: SimVarValueType.Degree }],
            ['nav2Available', { name: 'NAV HAS NAV:2', type: SimVarValueType.Bool }],
            ['nav2TuningMode', { name: 'L:A32NX_FMGC_RADIONAV_2_TUNING_MODE', type: SimVarValueType.Enum }],
        ]), bus);
    }
}

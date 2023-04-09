/* eslint-disable jsx-a11y/label-has-associated-control */
import { ClockEvents, ComponentProps, DisplayComponent, EventBus, FSComponent, Subject, VNode } from 'msfssdk';
import { DisplayUnit } from '../MsfsAvionicsCommon/displayUnit';
import './style.scss';
import { MFDSimvars } from './shared/MFDSimvarPublisher';

export const getDisplayIndex = () => {
    const url = document.getElementsByTagName('a32nx-pfd')[0].getAttribute('url');
    return url ? parseInt(url.substring(url.length - 1), 10) : 0;
};

interface MFDProps extends ComponentProps {
    bus: EventBus;
    instrument: BaseInstrument;
}

export class MFDComponent extends DisplayComponent<MFDProps> {
    private displayBrightness = Subject.create(0);

    private displayFailed = Subject.create(false);

    private displayPowered = Subject.create(false);

    public onAfterRender(node: VNode): void {
        super.onAfterRender(node);

        const isCaptainSide = getDisplayIndex() === 1;

        const sub = this.props.bus.getSubscriber<ClockEvents & MFDSimvars>();

        sub.on(isCaptainSide ? 'potentiometerCaptain' : 'potentiometerFo').whenChanged().handle((value) => {
            this.displayBrightness.set(value);
        });

        sub.on(isCaptainSide ? 'elec' : 'elecFo').whenChanged().handle((value) => {
            this.displayPowered.set(value === 1);
        });
    }

    render(): VNode {
        return (
            <DisplayUnit
                failed={this.displayFailed}
                bus={this.props.bus}
                powered={this.displayPowered}
                brightness={this.displayBrightness}
                normDmc={getDisplayIndex()}
            >
                <div class="mfd-main">
                    {/* begin header */}
                    <div style="display: flex; flex-direction: row;">
                        <div class="MFDSysSelectorOuter">
                            <div style="background-color: #040405; display: flex; flex: 4; margin: 4px;">
                                <span class="MFDSysSelectorLabel">
                                    FMS 1
                                </span>
                            </div>
                            <div style="display: flex; flex: 1; justify-content: center;">
                                <span style="color: white; align-self: center;">
                                    <svg height="10" width="10">
                                        <polygon points="0,0 10,0 5,10" style="fill: white" />
                                    </svg>
                                </span>
                            </div>
                        </div>
                    </div>
                    <div style="display: flex; flex-direction: row;">
                        <div class="MFDPageSelectorOuter">
                            <div style="display: flex; flex: 8; justify-content: center;">
                                <span class="MFDPageSelectorLabel active">
                                    ACTIVE
                                </span>
                            </div>
                            <div style="display: flex;">
                                <span style="padding: 8px;">
                                    <svg height="10" width="10">
                                        <polygon points="0,0 10,0 5,10" style="fill: white" />
                                    </svg>
                                </span>
                            </div>
                        </div>
                        <div class="MFDPageSelectorOuter">
                            <div style="display: flex; flex: 8; justify-content: center;">
                                <span class="MFDPageSelectorLabel">
                                    POSITION
                                </span>
                            </div>
                            <div style="display: flex;">
                                <span style="padding: 8px;">
                                    <svg height="10" width="10">
                                        <polygon points="0,0 10,0 5,10" style="fill: white" />
                                    </svg>
                                </span>
                            </div>
                        </div>
                        <div class="MFDPageSelectorOuter">
                            <div style="display: flex; flex: 8; justify-content: center;">
                                <span class="MFDPageSelectorLabel">
                                    SEC
                                </span>
                            </div>
                            <div style="display: flex;">
                                <span style="padding: 8px;">
                                    <svg height="10" width="10">
                                        <polygon points="0,0 10,0 5,10" style="fill: white" />
                                    </svg>
                                </span>
                            </div>
                        </div>
                        <div class="MFDPageSelectorOuter">
                            <div style="display: flex; flex: 8; justify-content: center;">
                                <span class="MFDPageSelectorLabel">
                                    DATA
                                </span>
                            </div>
                            <div style="display: flex;">
                                <span style="padding: 8px;">
                                    <svg height="10" width="10">
                                        <polygon points="0,0 10,0 5,10" style="fill: white" />
                                    </svg>
                                </span>
                            </div>
                        </div>
                    </div>
                    <div style="display: flex;">
                        <div style="flex: 10; background-color: #a0a0a0;">
                            <span class="MFDLabel" style="color: #222222; padding-left: 7px; font-size: 26px;">ACTIVE/PERF</span>
                        </div>
                        <div style="width: 60px; background-color: #a0a0a0; margin-left: 2px;" />
                        <div style="width: 80px; background-color: #a0a0a0; margin-left: 2px;" />
                    </div>
                    {/* end header */}
                    {/* begin page content */}
                    <div class="MFDPageContainer">
                        <div style="margin: 15px; display: flex; justify-content: space-between;">
                            <div class="MFDLabelValueContainer">
                                <span class="MFDLabel spacingRight">CRZ</span>
                                <div class="MFDTextInput">
                                    <span class="MFDUnitLabel leadingUnit">FL</span>
                                    <span class="MFDCyanValue">350</span>
                                </div>
                            </div>
                            <div class="MFDLabelValueContainer">
                                <span class="MFDLabel spacingRight">OPT</span>
                                <span class="MFDUnitLabel leadingUnit">FL</span>
                                <span class="MFDGreenValue">370</span>
                            </div>
                            <div class="MFDLabelValueContainer">
                                <span class="MFDLabel spacingRight">REC MAX</span>
                                <span class="MFDUnitLabel leadingUnit">FL</span>
                                <span class="MFDGreenValue">393</span>
                            </div>
                        </div>
                        <div class="MFDTopTabNavigatorContainer">
                            <div class="MFDTopTabNavigatorBar">
                                <div class="MFDTopTabNavigatorBarElementOuter active">
                                    <svg height="36" width="6.35">
                                        <polygon points="0,36 6.35,0 6.35,36" style="fill:#040405;" />
                                        <line x1="0" y1="36" x2="6.35" y2="0" style="stroke: lightgrey; stroke-width:2" />
                                    </svg>
                                    <span class="MFDTopTabNavigatorBarElementLabel active">T.O</span>
                                    <svg height="36" width="6.35">
                                        <polygon points="0,0 6.35,36 0,36" style="fill: #040405;" />
                                        <line x1="0" y1="0" x2="6.35" y2="36" style="stroke: lightgrey; stroke-width:2" />
                                    </svg>
                                </div>
                                <div class="MFDTopTabNavigatorBarElementOuter">
                                    <svg height="36" width="6.35">
                                        <polygon points="0,36 6.35,0 6.35,36" style="fill:#3c3c3c;" />
                                        <line x1="0" y1="36" x2="6.35" y2="0" style="stroke: lightgrey; stroke-width:2" />
                                        <line x1="0" y1="35" x2="6.35" y2="35" style="stroke: lightgrey; stroke-width:2" />
                                        {/* only if tab inactive */}
                                    </svg>
                                    <span class="MFDTopTabNavigatorBarElementLabel">CLB</span>
                                    <svg height="36" width="6.35">
                                        <polygon points="0,0 6.35,36 0,36" style="fill: #3c3c3c;" />
                                        <line x1="0" y1="0" x2="6.35" y2="36" style="stroke: lightgrey; stroke-width:2" />
                                        <line x1="0" y1="35" x2="6.35" y2="35" style="stroke: lightgrey; stroke-width:2" />
                                        {/* only if tab inactive */}
                                    </svg>
                                </div>
                                <div class="MFDTopTabNavigatorBarElementOuter">
                                    <svg height="36" width="6.35">
                                        <polygon points="0,36 6.35,0 6.35,36" style="fill:#3c3c3c;" />
                                        <line x1="0" y1="36" x2="6.35" y2="0" style="stroke: lightgrey; stroke-width:2" />
                                        <line x1="0" y1="35" x2="6.35" y2="35" style="stroke: lightgrey; stroke-width:2" />
                                        {/* only if tab inactive */}
                                    </svg>
                                    <span class="MFDTopTabNavigatorBarElementLabel">CRZ</span>
                                    <svg height="36" width="6.35">
                                        <polygon points="0,0 6.35,36 0,36" style="fill: #3c3c3c;" />
                                        <line x1="0" y1="0" x2="6.35" y2="36" style="stroke: lightgrey; stroke-width:2" />
                                        <line x1="0" y1="35" x2="6.35" y2="35" style="stroke: lightgrey; stroke-width:2" />
                                        {/* only if tab inactive */}
                                    </svg>
                                </div>
                                <div class="MFDTopTabNavigatorBarElementOuter">
                                    <svg height="36" width="6.35">
                                        <polygon points="0,36 6.35,0 6.35,34" style="fill:#3c3c3c;" />
                                        <line x1="0" y1="36" x2="6.35" y2="0" style="stroke: lightgrey; stroke-width:2" />
                                        <line x1="0" y1="35" x2="6.35" y2="35" style="stroke: lightgrey; stroke-width:2" />
                                        {/* only if tab inactive */}
                                    </svg>
                                    <span class="MFDTopTabNavigatorBarElementLabel">DES</span>
                                    <svg height="36" width="6.35">
                                        <polygon points="0,0 6.35,36 0,36" style="fill: #3c3c3c;" />
                                        <line x1="0" y1="0" x2="6.35" y2="36" style="stroke: lightgrey; stroke-width:2" />
                                        <line x1="0" y1="35" x2="6.35" y2="35" style="stroke: lightgrey; stroke-width:2" />
                                        {/* only if tab inactive */}
                                    </svg>
                                </div>
                                <div class="MFDTopTabNavigatorBarElementOuter">
                                    <svg height="36" width="6.35">
                                        <polygon points="0,36 6.35,0 6.35,34" style="fill:#3c3c3c;" />
                                        <line x1="0" y1="36" x2="6.35" y2="0" style="stroke: lightgrey; stroke-width:2" />
                                        <line x1="0" y1="35" x2="6.35" y2="35" style="stroke: lightgrey; stroke-width:2" />
                                        {/* only if tab inactive */}
                                    </svg>
                                    <span class="MFDTopTabNavigatorBarElementLabel">APPR</span>
                                    <svg height="36" width="6.35">
                                        <polygon points="0,0 6.35,36 0,36" style="fill: #3c3c3c;" />
                                        <line x1="0" y1="0" x2="6.35" y2="36" style="stroke: lightgrey; stroke-width:2" />
                                        <line x1="0" y1="35" x2="6.35" y2="35" style="stroke: lightgrey; stroke-width:2" />
                                        {/* only if tab inactive */}
                                    </svg>
                                </div>
                                <div class="MFDTopTabNavigatorBarElementOuter">
                                    <svg height="36" width="6.35">
                                        <polygon points="0,36 6.35,0 6.35,34" style="fill:#3c3c3c;" />
                                        <line x1="0" y1="36" x2="6.35" y2="0" style="stroke: lightgrey; stroke-width:2" />
                                        <line x1="0" y1="35" x2="6.35" y2="35" style="stroke: lightgrey; stroke-width:2" />
                                        {/* only if tab inactive */}
                                    </svg>
                                    <span class="MFDTopTabNavigatorBarElementLabel">GA</span>
                                    <svg height="36" width="6.35">
                                        <polygon points="0,0 6.35,36 0,36" style="fill: #3c3c3c;" />
                                        <line x1="0" y1="0" x2="6.35" y2="36" style="stroke: lightgrey; stroke-width:2" />
                                        <line x1="0" y1="35" x2="6.35" y2="35" style="stroke: lightgrey; stroke-width:2" />
                                        {/* only if tab inactive */}
                                    </svg>
                                </div>
                            </div>
                            <div class="MFDTopTabNavigatorTabContent">
                                <div style="display: flex; justify-content: space-between; border-bottom: 1px solid lightgrey">
                                    <div class="MFDLabelValueContainer" style="padding: 15px;">
                                        <span class="MFDLabel spacingRight">RWY</span>
                                        <span class="MFDGreenValue">14L</span>
                                    </div>
                                </div>
                                <div style="display: flex; flex-direction: row;">
                                    <div style="flex: 5; display: grid; grid-template-columns: auto auto;
                                    justify-content: space-between; border-right: 1px solid lightgrey; padding-top: 10px; margin-top: 5px; padding-right: 20px"
                                    >
                                        <div class="MFDLabelValueContainer">
                                            <span class="MFDLabel spacingRight">V1</span>
                                            <div class="MFDTextInput">
                                                <span class="MFDCyanValue">135</span>
                                                <span class="MFDUnitLabel trailingUnit">KT</span>
                                            </div>
                                        </div>
                                        <div class="MFDLabelValueContainer">
                                            <span class="MFDLabel spacingRight">F</span>
                                            <span class="MFDGreenValue">169</span>
                                            <span class="MFDUnitLabel trailingUnit">KT</span>
                                        </div>
                                        <div class="MFDLabelValueContainer">
                                            <span class="MFDLabel spacingRight">VR</span>
                                            <div class="MFDTextInput">
                                                <span class="MFDCyanValue">140</span>
                                                <span class="MFDUnitLabel trailingUnit">KT</span>
                                            </div>
                                        </div>
                                        <div class="MFDLabelValueContainer">
                                            <span class="MFDLabel spacingRight">S</span>
                                            <span class="MFDGreenValue">220</span>
                                            <span class="MFDUnitLabel trailingUnit">KT</span>
                                        </div>
                                        <div class="MFDLabelValueContainer">
                                            <span class="MFDLabel spacingRight">V2</span>
                                            <div class="MFDTextInput">
                                                <span class="MFDCyanValue">145</span>
                                                <span class="MFDUnitLabel trailingUnit">KT</span>
                                            </div>
                                        </div>
                                        <div class="MFDLabelValueContainer">
                                            <span class="MFDLabel spacingRight">O</span>
                                            <span class="MFDGreenValue">246</span>
                                            <span class="MFDUnitLabel trailingUnit">KT</span>
                                        </div>
                                    </div>
                                    <div style="flex: 4; display: flex; flex-direction: column; justify-items: center; justify-content: center; ">
                                        <label class="container">
                                            TOGA
                                            <input type="checkbox" checked="checked" />
                                            <span class="checkmark" />
                                        </label>
                                        <label class="container">
                                            FLEX
                                            <input type="checkbox" />
                                            <span class="checkmark" />
                                        </label>
                                        <label class="container">
                                            DERATED
                                            <input type="checkbox" />
                                            <span class="checkmark" />
                                        </label>
                                    </div>
                                </div>
                                <div style="margin: 15px 0px 15px 0px; display: flex; justify-content: space-between;">
                                    <div class="MFDLabelValueContainer">
                                        <span class="MFDLabel spacingRight">FLAPS</span>
                                        <div class="MFDDropdownOuter">
                                            <div style="background-color: #040405; display: flex; margin: 4px;">
                                                <span class="MFDDropdownLabel">
                                                    1
                                                </span>
                                            </div>
                                            <div style="display: flex; justify-content: center; padding-right: 5px;">
                                                <span style="color: white; align-self: center;">
                                                    <svg height="10" width="10">
                                                        <polygon points="0,0 10,0 5,10" style="fill: white" />
                                                    </svg>
                                                </span>
                                            </div>
                                        </div>
                                    </div>
                                    <div class="MFDLabelValueContainer">
                                        <span class="MFDLabel spacingRight">THS FOR</span>
                                        <div class="MFDTextInput">
                                            <span class="MFDCyanValue">39.0</span>
                                            <span class="MFDUnitLabel trailingUnit">%</span>
                                        </div>
                                    </div>
                                    <div class="MFDLabelValueContainer">
                                        <span class="MFDLabel spacingRight">T.O SHIFT</span>
                                        <div class="MFDTextInput" style="padding-left: 20px; padding-right: 20px;">
                                            <span class="MFDCyanValue">----</span>
                                            <span class="MFDUnitLabel trailingUnit">M</span>
                                        </div>
                                    </div>
                                </div>
                                <div style="display: grid; grid-template-columns: auto auto; justify-content: space-between; margin: 10px 80px 10px 80px;">
                                    <div class="MFDLabelValueContainer" style="justify-content: flex-end;">
                                        <span class="MFDLabel spacingRight">THR RED</span>
                                        <div class="MFDTextInput" style="width: 125px; justify-content: flex-end;">
                                            <span class="MFDCyanValue">3000</span>
                                            <span class="MFDUnitLabel trailingUnit">FT</span>
                                        </div>
                                    </div>
                                    <div class="MFDLabelValueContainer" />
                                    <div class="MFDLabelValueContainer" style="justify-content: flex-end;">
                                        <span class="MFDLabel spacingRight">ACCEL</span>
                                        <div class="MFDTextInput" style="width: 125px; justify-content: flex-end;">
                                            <span class="MFDCyanValue">800</span>
                                            <span class="MFDUnitLabel trailingUnit">FT</span>
                                        </div>
                                    </div>
                                    <div class="MFDLabelValueContainer">
                                        <span class="MFDLabel spacingRight">EO ACCEL</span>
                                        <div class="MFDTextInput" style="width: 125px; justify-content: flex-end;">
                                            <span class="MFDCyanValue">1990</span>
                                            <span class="MFDUnitLabel trailingUnit">FT</span>
                                        </div>
                                    </div>
                                </div>
                                <div style="margin: 20px 2px 3px 2px; display: flex; flex-direction: row;">
                                    <div style="display: flex; flex: 1;">
                                        <span class="MFDButton" style="align-items: center;">
                                            NOISE
                                        </span>
                                    </div>
                                </div>
                                <div style="flex-grow: 1;" />
                                {/* fill space vertically */}
                                <div style="margin: 20px 2px 3px 2px; display: flex; flex-direction: row; justify-self: flex-end;">
                                    <div class="MFDLabelValueContainer" style="flex: 4; margin-left: 80px;">
                                        <span class="MFDLabel spacingRight">TRANS</span>
                                        <div class="MFDTextInput" style="width: 125px; justify-content: flex-end;">
                                            <span class="MFDCyanValue">5000</span>
                                            <span class="MFDUnitLabel trailingUnit">FT</span>
                                        </div>
                                    </div>
                                    <span class="MFDButton" style="flex: 1;">
                                        CPNY T.O
                                        <br />
                                        REQUEST
                                    </span>
                                </div>
                            </div>
                        </div>
                        <div style="margin: 20px 2px 3px 2px; display: flex; flex-direction: row;">
                            <div style="display: flex; flex: 1;">
                                <span class="MFDButton" style="align-items: center;">
                                    RETURN
                                </span>
                            </div>
                            <span class="MFDButton">
                                POS MONITOR
                            </span>
                            <div style="flex: 1" />
                        </div>
                    </div>
                    {/* end page content */}
                    {/* begin footer */}
                    <div style="display: flex; border-top: 2px solid #3c3c3c; padding: 5px;">
                        <span class="MFDButton">
                            CLEAR
                            <br />
                            INFO
                        </span>
                    </div>
                    {/* end footer */}
                </div>
            </DisplayUnit>
        );
    }
}

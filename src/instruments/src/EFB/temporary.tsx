import ReactDOM from 'react-dom';
import { useState } from 'react';
import Efb from './Efb';
import { renderTarget, useUpdate, getSimVar } from './../util.mjs';
import logo from './Assets/fbw-logo.svg';
import './Assets/Boot.scss';
import soon from './Assets/soon.png';

declare var Simplane: any;
declare var React: any;

// TODO: Move anything dependent on ac power change to A32NX_Core
function powerAvailable() {
    // These are inlined so they're only evaluated if prior conditions return false.
    return (
        Simplane.getEngineActive(0) === 1 || Simplane.getEngineActive(1) === 1
    ) || (
        getSimVar('L:APU_GEN_ONLINE')
    ) || (
        getSimVar('EXTERNAL POWER AVAILABLE:1') && getSimVar('EXTERNAL POWER ON')
    );
}

function ScreenLoading() {
    return (
        <div className="loading-screen">
            <div className="center">
                <div className="placeholder">
                    <img src={logo} className="fbw-logo" alt="logo" />
                    {' '}
                    flyPad
                </div>
                <div className="loading-bar">
                    <div className="loaded" />
                </div>
            </div>
        </div>
    );
}

function EFBLoad() {
    const [state, setState] = useState('DEFAULT');
    const currentFlight = getSimVar('ATC FLIGHT NUMBER');

    useUpdate((_deltaTime) => {
        if (state === 'OFF') {
            if (powerAvailable()) {
                setState('ON');
            }
        } else if (!powerAvailable()) {
            setState('OFF');
        }
    });

    switch (state) {
    case 'DEFAULT':
        if (getSimVar('L:A32NX_COLD_AND_DARK_SPAWN')) {
            setState('OFF');
        } else {
            setState('START');
        }
        return <></>;
    case 'OFF':
        return <></>;
    case 'ON':
        setTimeout(() => {
            if (powerAvailable()) {
                setState('START');
            }
        }, 6000);
        return <ScreenLoading />;
    case 'START':
        return  <div className="wrapper">     
        <img className="soon" src={soon} />
    </div>;
    default:
        throw new RangeError();
    }
}

ReactDOM.render(<EFBLoad />, renderTarget);
/*
 * A32NX
 * Copyright (C) 2020-2021 FlyByWire Simulations and its contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */

import ReactDOM from 'react-dom';


import soon from './Assets/soon.png';

declare var React: any;

function EfbSoon() {
    return (<img src={soon} alt="" style={{width: 1250, marginTop: '300px', marginLeft: '15px'}}/>);
}

ReactDOM.render(<EfbSoon />, document.getElementById('A32NX_REACT_MOUNT'));

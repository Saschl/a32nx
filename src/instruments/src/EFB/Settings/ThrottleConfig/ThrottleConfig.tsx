import React, { useEffect, useState } from 'react';
import { Toggle } from '@flybywiresim/react-components';
import { usePersistentPropertyWithDefault } from '../../../Common/persistence';
import { useSimVar } from '../../../Common/simVars';
import Button, { BUTTON_TYPE } from '../../Components/Button/Button';
import { SelectItem, VerticalSelectGroup } from '../../Components/Form/Select';

import BaseThrottleConfig from './BaseThrottleConfig';
import { ThrottleSimvar } from './ThrottleSimVar';

interface Props {
    isShown: boolean,
    onClose: any
}

const ReverserAssistant = () => {
    const [, setInitialize] = useState(false);

    const [, setReverserOnAxis1] = useSimVar('L:A32NX_THROTTLE_MAPPING_USE_REVERSE_ON_AXIS:1', 'number', 1000);
    const [, setReverserOnAxis2] = useSimVar('L:A32NX_THROTTLE_MAPPING_USE_REVERSE_ON_AXIS:2', 'number', 1000);

    const [, syncToThrottle] = useSimVar('K:A32NX.THROTTLE_MAPPING_LOAD_FROM_FILE', 'number', 100);

    const setReversersOnAxis = (reverserOnAxis: number) => {
        setReverserOnAxis1(reverserOnAxis);
        setReverserOnAxis2(reverserOnAxis);
        if (reverserOnAxis === 0) {
            // setSelectedIndex(2);
        } else {
            // setSelectedIndex(0);
        }
    };
    return (
        <div className="m-auto flex flex-row">
            <p>
                Do you have a reverser Axis on your throttle? (Answer No if you don't know what that means and refrain from flying the plane please.)
            </p>
            <Button
                text="Load From File"
                type={BUTTON_TYPE.BLUE}
                onClick={() => {
                    syncToThrottle(1);
                    setTimeout(() => {
                        setInitialize(true);
                    }, 1000);
                }}
                className="ml-2 hover:bg-blue-600 hover:border-blue-600"
            />
            <Button className="ml-2 hover:bg-blue-600 hover:border-blue-600" onClick={() => setReversersOnAxis(1)} text="Yes" />
            <Button className="ml-2 hover:bg-blue-600 hover:border-blue-600" onClick={() => setReversersOnAxis(0)} text="No" />
        </div>
    );
};

const DualAxisAssistant = () => {
    const [, setDualAxis] = usePersistentPropertyWithDefault('THROTTLE_DUAL_AXIS', '1');
    const [, setSelectedIndex] = useState(-2);

    return (
        <div className="m-auto flex flex-row">
            <p>
                Do you have a one or two Axis on your throttle? (Answer one if you don't know what that means and refrain from flying the plane please.)
            </p>
            <Button
                className="ml-2 hover:bg-blue-600 hover:border-blue-600"
                onClick={() => setDualAxis(0)}
                text="One"
            />
            <Button
                className="ml-2 hover:bg-blue-600 hover:border-blue-600"
                onClick={() => setDualAxis(0)}
                text="Two"
            />
            <Button
                className="ml-2 hover:bg-blue-600 hover:border-blue-600"
                onClick={() => setSelectedIndex(0)}
                text="NExt"
            />
        </div>
    );
};

const ThrottleAssistant = ({ throttleNo, dualAxis, mappingsAxisOne, mappingsAxisTwo, selectedIndex }) => (
    <div className="flex flex-col">
        { (dualAxis === 1 && throttleNo >= 0) && (
            <div className="flex flex-row justify-center">
                <div className="ml-4" />

                <BaseThrottleConfig
                    mappingsAxisOne={mappingsAxisOne}
                    disabled={false}
                    throttleNumber={1}
                    throttleCount={parseInt(dualAxis) === 0 ? 2 : 1}
                    activeIndex={throttleNo}
                    initialize={false}
                    setInitialize={() => { }}
                />

                <BaseThrottleConfig
                    mappingsAxisOne={mappingsAxisTwo}
                    disabled={false}
                    throttleNumber={2}
                    throttleCount={1}
                    activeIndex={throttleNo}
                    initialize={false}
                    setInitialize={() => { }}
                />
                <div className="mr-4" />
            </div>
        )}

        { (dualAxis === 0 && throttleNo >= 0)
        && (
            <div className="flex flex-row ml-4 justify-center">
                <BaseThrottleConfig
                    mappingsAxisOne={mappingsAxisOne}
                    mappingsAxisTwo={mappingsAxisTwo}
                    disabled={false}
                    throttleNumber={1}
                    throttleCount={2}
                    activeIndex={throttleNo}
                    initialize={false}
                    setInitialize={() => { }}
                />

            </div>
        )}

        {selectedIndex < 0 && (
            <div className="flex flex-col divide divide-y-4">
                <DualAxisAssistant />
                <ReverserAssistant />
            </div>
        )}

    </div>
);

const ThrottleConfig: React.FC<Props> = (props: Props) => {
    if (!props.isShown) {
        return null;
    }

    const [isDualAxis] = usePersistentPropertyWithDefault('THROTTLE_DUAL_AXIS', '1');

    const [selectedIndex, setSelectedIndex] = useState(-2);

    const [, setInitialize] = useState(false);

    const [reverserOnAxis1] = useSimVar('L:A32NX_THROTTLE_MAPPING_USE_REVERSE_ON_AXIS:1', 'number', 1000);

    const [, syncToDisk] = useSimVar('K:A32NX.THROTTLE_MAPPING_SAVE_TO_FILE', 'number', 1000);
    const [, syncToThrottle] = useSimVar('K:A32NX.THROTTLE_MAPPING_LOAD_FROM_FILE', 'number', 100);
    const [, applyLocalVar] = useSimVar('K:A32NX.THROTTLE_MAPPING_LOAD_FROM_LOCAL_VARIABLES', 'number', 1000);

    const mappingsAxisOne: Array<ThrottleSimvar> = [
        new ThrottleSimvar('Reverse Full', 'L:A32NX_THROTTLE_MAPPING_REVERSE_', 1),
        new ThrottleSimvar('Reverse Idle', 'L:A32NX_THROTTLE_MAPPING_REVERSE_IDLE_', 1),
        new ThrottleSimvar('Idle', 'L:A32NX_THROTTLE_MAPPING_IDLE_', 1),
        new ThrottleSimvar('Climb', 'L:A32NX_THROTTLE_MAPPING_CLIMB_', 1),
        new ThrottleSimvar('Flex', 'L:A32NX_THROTTLE_MAPPING_FLEXMCT_', 1),
        new ThrottleSimvar('TOGA', 'L:A32NX_THROTTLE_MAPPING_TOGA_', 1),
    ];
    const mappingsAxisTwo: Array<ThrottleSimvar> = [
        new ThrottleSimvar('Reverse Full', 'L:A32NX_THROTTLE_MAPPING_REVERSE_', 2),
        new ThrottleSimvar('Reverse Idle', 'L:A32NX_THROTTLE_MAPPING_REVERSE_IDLE_', 2),
        new ThrottleSimvar('Idle', 'L:A32NX_THROTTLE_MAPPING_IDLE_', 2),
        new ThrottleSimvar('Climb', 'L:A32NX_THROTTLE_MAPPING_CLIMB_', 2),
        new ThrottleSimvar('Flex', 'L:A32NX_THROTTLE_MAPPING_FLEXMCT_', 2),
        new ThrottleSimvar('TOGA', 'L:A32NX_THROTTLE_MAPPING_TOGA_', 2),
    ];

    useEffect(() => {
        if (reverserOnAxis1 === 0 && selectedIndex < 2) {
            // setSelectedIndex(2);
        }
    });

    /*     const switchDetent = (index: number) => {
        if (index >= 0 && index <= 5) {
            setSelectedIndex(index);
        }
    }; */

    const isConfigValid = () => {
        const errors: string[] = [];
        for (let index = reverserOnAxis1 ? 0 : 2; index < mappingsAxisOne.length; index++) {
            const element = mappingsAxisOne[index];
            for (let nextIndex = index + 1; nextIndex < mappingsAxisOne.length; nextIndex++) {
                const nextElement = mappingsAxisOne[nextIndex];
                if (element.getHiGetter() >= nextElement.getLowGetter() || element.getLowGetter() >= nextElement.getHiGetter()) {
                    errors.push(`${element.readableName} (${element.getLowGetter().toFixed(2)}) overlaps with ${nextElement.readableName} (${nextElement.getLowGetter().toFixed(2)})`);
                }
            }
        }
        for (let index = reverserOnAxis1 ? 0 : 2; index < mappingsAxisTwo.length; index++) {
            const element = mappingsAxisTwo[index];
            for (let nextIndex = index + 1; nextIndex < mappingsAxisTwo.length; nextIndex++) {
                const nextElement = mappingsAxisTwo[nextIndex];
                if (element.getHiGetter() >= nextElement.getLowGetter() || element.getLowGetter() >= nextElement.getHiGetter()) {
                    errors.push(`${element.readableName} (${element.getLowGetter().toFixed(2)}) overlaps with ${nextElement.readableName} (${nextElement.getLowGetter().toFixed(2)})`);
                }
            }
        }
        return errors;
    };

    const goForward = () => {
        if (selectedIndex < 5) {
            setSelectedIndex(selectedIndex + 1);
        }
    };

    const goBack = () => {
        if (selectedIndex > -2) {
            setSelectedIndex(selectedIndex - 1);
        }
    };

    return (
        <div className="flex flex-col pt-4 text-center">
            <div className="rounded-xl py-6">

                <div className="flex flex-row rounded-2xl justify-center bg-navy-lighter mt-auto mb-8 p-4 w-full divide divide-x-2 divide-gray-500">


                    <div className="flex flex-col">
                        <ThrottleAssistant
                            throttleNo={selectedIndex}
                            dualAxis={parseInt(isDualAxis)}
                            mappingsAxisOne={mappingsAxisOne}
                            mappingsAxisTwo={mappingsAxisTwo}
                            selectedIndex={selectedIndex}
                        />
                        <div className="flex flex-row justify-center">
                            <Button
                                text="Load From File"
                                type={BUTTON_TYPE.BLUE}
                                onClick={() => goForward()}
                                className="ml-2 hover:bg-blue-600 hover:border-blue-600"
                            />
                            <Button
                                text="Previous"
                                type={BUTTON_TYPE.BLUE}
                                onClick={() => goBack()}
                                className="ml-4 mr-auto hover:bg-blue-600 hover:border-blue-600"
                            />
                        </div>

                </div>

                {parseInt(isDualAxis) === 1 && (
                    <div className="flex flex-row justify-center rounded-xl">
                        <div className="ml-4" />

                        <BaseThrottleConfig
                            mappingsAxisOne={mappingsAxisOne}
                            disabled={false}
                            throttleNumber={1}
                            throttleCount={parseInt(isDualAxis) === 0 ? 2 : 1}
                            activeIndex={selectedIndex}
                            initialize={initialize}
                            setInitialize={setInitialize}
                        />
                        <div className="mr-8 ml-8 mt-auto mb-auto">
                            {navigationBar}
                        </div>
                        <BaseThrottleConfig
                            mappingsAxisOne={mappingsAxisTwo}
                            disabled={false}
                            throttleNumber={2}
                            throttleCount={1}
                            activeIndex={selectedIndex}
                            initialize={initialize}
                            setInitialize={setInitialize}
                        />
                        <div className="mr-4" />
                    </div>
                )}

                {parseInt(isDualAxis) === 0
                    && (
                        <div className="flex flex-row ml-4 justify-center rounded-xl">
                            <BaseThrottleConfig
                                mappingsAxisOne={mappingsAxisOne}
                                mappingsAxisTwo={mappingsAxisTwo}
                                disabled={false}
                                throttleNumber={1}
                                throttleCount={2}
                                activeIndex={selectedIndex}
                                initialize={initialize}
                                setInitialize={setInitialize}
                            />
                            <div className="ml-8 mt-auto mb-auto">
                                {navigationBar}
                            </div>
                        </div>
                    )}
            </div>

            <div className="text-xl text-red-600">{isConfigValid().length > 0 ? isConfigValid()[0] : ''}</div>
            <div className="bg-navy-lighter flex flex-row-reverse h-16 p-2 w-full mt-40 mb-2 rounded-2xl">

                <Button
                    text="Save &amp; Apply"
                    type={BUTTON_TYPE.GREEN}
                    onClick={() => {
                        if (isConfigValid()) {
                            syncToDisk(1);
                            applyLocalVar(1);
                        }
                    }}
                    disabled={!isConfigValid}
                    className={`ml-2 mr-4 ${isConfigValid().length === 0 ? 'bg-green-500 border-green-500 hover:bg-green-600 hover:border-green-600' : 'opacity-30'}`}
                />
                <Button
                    text="Apply"
                    type={BUTTON_TYPE.BLUE}
                    onClick={() => applyLocalVar(1)}
                    className={`ml-2 ${isConfigValid().length === 0 ? 'bg-blue-500 border-blue-500 hover:bg-blue-600 hover:border-blue-600' : 'bg-gray-500 opacity-30'}`}
                />
                <Button
                    text="Load From File"
                    type={BUTTON_TYPE.BLUE}
                    onClick={() => {
                        syncToThrottle(1);
                        setTimeout(() => {
                            setInitialize(true);
                        }, 1000);
                    }}
                    className="ml-2 hover:bg-blue-600 hover:border-blue-600"
                />
                <Button
                    text="Back"
                    type={BUTTON_TYPE.BLUE}
                    onClick={() => props.onClose()}
                    className="ml-4 mr-auto hover:bg-blue-600 hover:border-blue-600"
                />
            </div>
        </div>
    );
};

export default ThrottleConfig;

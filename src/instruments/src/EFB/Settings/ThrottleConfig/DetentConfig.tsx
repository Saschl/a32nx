import React, { useEffect, useState, useMemo } from 'react';
import { usePersistentProperty } from '../../../Common/persistence';

import Button, { BUTTON_TYPE } from '../../Components/Button/Button';
import Input from '../../Components/Form/Input/Input';
import { ProgressBar } from '../../Components/Progress/Progress';
import { debounce } from 'lodash';

interface Props {
    upperBoundDetentSetter,
    lowerBoundDetentSetter,
    lowerBoundDetentGetter,
    upperBoundDetentGetter,
    detentValue,
    throttleNumber,
    throttlePosition,
    index,
    barPosition: string,
    initialize: boolean,
    setInitialize,
}

const DetentConfig: React.FC<Props> = (props: Props) => {
    const [showWarning, setShowWarning] = useState(false);

    const [deadZone, setDeadZone] = usePersistentProperty(`THROTTLE_${props.throttleNumber}DETENT_${props.index}_RANGE`, '0.05');

    const [axisValue, setAxisValue] = usePersistentProperty(`THROTTLE_${props.throttleNumber}AXIS_${props.index}_VALUE`);

    const setFromTo = (throttle1Position, settingLower, settingUpper, deadZone: number, overrideValue?: string) => {
        const newSetting = overrideValue || throttle1Position;

        setAxisValue(newSetting.toFixed(2));
        if (deadZone) {
            settingLower.forEach((f) => f(newSetting - deadZone < -1 ? -1 : newSetting - deadZone));
            settingUpper.forEach((f) => f(newSetting + deadZone > 1 ? 1 : newSetting + deadZone));
        }
    };

    const applyDeadzone = (settingLower, settingUpper, axisValue: number, deadZone: number) => {
        settingLower.forEach((f) => f(axisValue - deadZone < -1 ? -1 : axisValue - deadZone));
        settingUpper.forEach((f) => f(axisValue + deadZone > 1 ? 1 : axisValue + deadZone));
    };


  const changeHandler = (deadZoneNew: number) => {
    applyDeadzone(props.lowerBoundDetentSetter, props.upperBoundDetentSetter, parseFloat(axisValue), parseFloat(deadZoneNew));
  };

    const debouncedChangeHandler = useMemo(
        () => debounce(changeHandler, 300)
      , []);

    useEffect(() => {
        // initialize persistent values from previous configurations
        if (!axisValue || props.initialize) {
            const axisValue = (props.lowerBoundDetentGetter + props.upperBoundDetentGetter) / 2;
            const dz = Math.abs((Math.abs(props.upperBoundDetentGetter) - Math.abs(props.lowerBoundDetentGetter))) / 2;
            setAxisValue(axisValue.toFixed(2));
            if (dz > 0) {
                setDeadZone(dz.toFixed(2));
            }
            applyDeadzone(props.lowerBoundDetentSetter, props.upperBoundDetentSetter, axisValue, parseFloat(deadZone));
            props.setInitialize(false);
        }
    }, [axisValue, props, deadZone]);

    return (
        <div className="mb-2 w-full h-96 justify-between items-center p-2 flex flex-row flex-shrink-0">

            {props.barPosition === 'left'
            && (
                <div className="mr-8 h-full">
                    <ProgressBar
                        height="350px"
                        width="50px"
                        isLabelVisible={false}
                        displayBar
                        borderRadius="0px"
                        completedBarBegin={(props.lowerBoundDetentGetter + 1) * 50}
                        completedBarBeginValue={props.lowerBoundDetentGetter.toFixed(2)}
                        completedBarEnd={(props.upperBoundDetentGetter + 1) * 50}
                        completedBarEndValue={props.upperBoundDetentGetter.toFixed(2)}
                        bgcolor="#3b82f6"
                        vertical
                        baseBgColor="rgba(55, 65, 81, var(--tw-bg-opacity))"
                        completed={(props.throttlePosition + 1) / 2 * 100}
                        completionValue={props.throttlePosition}
                        greenBarsWhenInRange
                    />
                </div>
            ) }

            <>
            <div className="flex flex-col w-full">
                        <Input
                            label="Deadband +/-"
                            className=" w-52 dark-option mb-4"
                            value={deadZone}
                            onChange={(deadZoneNew) => {
                                if (parseFloat(deadZoneNew) >= 0.01) {
                                        debouncedChangeHandler(deadZoneNew);
                                        setShowWarning(false);
                                        setDeadZone(parseFloat(deadZoneNew).toFixed(2));

                                } else {
                                    setShowWarning(true);
                                }
                            }}
                        />
                        <Button
                            className="border-blue-500 bg-blue-500 hover:bg-blue-600 hover:border-blue-600"
                            text="Set From Throttle"
                            onClick={() => {
                                setFromTo(props.throttlePosition, props.lowerBoundDetentSetter, props.upperBoundDetentSetter, parseFloat(deadZone));
                            }}
                            type={BUTTON_TYPE.NONE}
                        />
                    </div>
                {showWarning && (
                    <h1 className="mt-4 text-red-600 text-xl">Please enter a valid deadzone (min. 0.1)</h1>
                )}

            </>
            {props.barPosition === 'right'
            && (
                <div className="ml-8 h-full">
                    <ProgressBar
                        height="350px"
                        width="50px"
                        isLabelVisible={false}
                        displayBar
                        borderRadius="0px"
                        completedBarBegin={(props.lowerBoundDetentGetter + 1) * 50}
                        completedBarBeginValue={props.lowerBoundDetentGetter.toFixed(2)}
                        completedBarEnd={(props.upperBoundDetentGetter + 1) * 50}
                        completedBarEndValue={props.upperBoundDetentGetter.toFixed(2)}
                        bgcolor="#3b82f6"
                        vertical
                        baseBgColor="rgba(55, 65, 81, var(--tw-bg-opacity))"
                        completed={(props.throttlePosition + 1) / 2 * 100}
                        completionValue={props.throttlePosition}
                        greenBarsWhenInRange
                    />
                </div>
            )}
        </div>
    );
};
export default DetentConfig;

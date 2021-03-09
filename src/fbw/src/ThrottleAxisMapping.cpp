#include "ThrottleAxisMapping.h"

using namespace std;

ThrottleAxisMapping::ThrottleAxisMapping(unsigned int id) {
  // save id
  this->id = id;

  // update string variables
  string stringId = to_string(id);
  CONFIGURATION_SECTION_AXIS = CONFIGURATION_SECTION_AXIS.append(stringId);
  LVAR_INPUT_VALUE = LVAR_INPUT_VALUE.append(stringId);
  LVAR_THRUST_LEVER_ANGLE = LVAR_THRUST_LEVER_ANGLE.append(stringId);
  LVAR_USE_REVERSE_ON_AXIS = LVAR_USE_REVERSE_ON_AXIS.append(stringId);
  LVAR_DETENT_REVERSE_LOW = LVAR_DETENT_REVERSE_LOW.append(stringId);
  LVAR_DETENT_REVERSE_HIGH = LVAR_DETENT_REVERSE_HIGH.append(stringId);
  LVAR_DETENT_REVERSEIDLE_LOW = LVAR_DETENT_REVERSEIDLE_LOW.append(stringId);
  LVAR_DETENT_REVERSEIDLE_HIGH = LVAR_DETENT_REVERSEIDLE_HIGH.append(stringId);
  LVAR_DETENT_IDLE_LOW = LVAR_DETENT_IDLE_LOW.append(stringId);
  LVAR_DETENT_IDLE_HIGH = LVAR_DETENT_IDLE_HIGH.append(stringId);
  LVAR_DETENT_CLIMB_LOW = LVAR_DETENT_CLIMB_LOW.append(stringId);
  LVAR_DETENT_CLIMB_HIGH = LVAR_DETENT_CLIMB_HIGH.append(stringId);
  LVAR_DETENT_FLEXMCT_LOW = LVAR_DETENT_FLEXMCT_LOW.append(stringId);
  LVAR_DETENT_FLEXMCT_HIGH = LVAR_DETENT_FLEXMCT_HIGH.append(stringId);
  LVAR_DETENT_TOGA_LOW = LVAR_DETENT_TOGA_LOW.append(stringId);
  LVAR_DETENT_TOGA_HIGH = LVAR_DETENT_TOGA_HIGH.append(stringId);

  // register local variables
  idInputValue = register_named_variable(LVAR_INPUT_VALUE.c_str());
  idThrustLeverAngle = register_named_variable(LVAR_THRUST_LEVER_ANGLE.c_str());
  idUseReverseOnAxis = register_named_variable(LVAR_USE_REVERSE_ON_AXIS.c_str());
  idDetentReverseLow = register_named_variable(LVAR_DETENT_REVERSE_LOW.c_str());
  idDetentReverseHigh = register_named_variable(LVAR_DETENT_REVERSE_HIGH.c_str());
  idDetentReverseIdleLow = register_named_variable(LVAR_DETENT_REVERSEIDLE_LOW.c_str());
  idDetentReverseIdleHigh = register_named_variable(LVAR_DETENT_REVERSEIDLE_HIGH.c_str());
  idDetentIdleLow = register_named_variable(LVAR_DETENT_IDLE_LOW.c_str());
  idDetentIdleHigh = register_named_variable(LVAR_DETENT_IDLE_HIGH.c_str());
  idDetentClimbLow = register_named_variable(LVAR_DETENT_CLIMB_LOW.c_str());
  idDetentClimbHigh = register_named_variable(LVAR_DETENT_CLIMB_HIGH.c_str());
  idDetentFlexMctLow = register_named_variable(LVAR_DETENT_FLEXMCT_LOW.c_str());
  idDetentFlexMctHigh = register_named_variable(LVAR_DETENT_FLEXMCT_HIGH.c_str());
  idDetentTogaLow = register_named_variable(LVAR_DETENT_TOGA_LOW.c_str());
  idDetentTogaHigh = register_named_variable(LVAR_DETENT_TOGA_HIGH.c_str());
}

void ThrottleAxisMapping::setInFlight() {
  inFlight = true;
}

void ThrottleAxisMapping::setOnGround() {
  inFlight = false;
}

double ThrottleAxisMapping::getValue() {
  return currentValue;
}

double ThrottleAxisMapping::getTLA() {
  return currentTLA;
}

bool ThrottleAxisMapping::loadFromLocalVariables() {
  updateConfiguration(get_named_variable_value(idUseReverseOnAxis) == 1, get_named_variable_value(idDetentReverseLow),
                      get_named_variable_value(idDetentReverseHigh), get_named_variable_value(idDetentReverseIdleLow),
                      get_named_variable_value(idDetentReverseIdleHigh), get_named_variable_value(idDetentIdleLow),
                      get_named_variable_value(idDetentIdleHigh), get_named_variable_value(idDetentClimbLow),
                      get_named_variable_value(idDetentClimbHigh), get_named_variable_value(idDetentFlexMctLow),
                      get_named_variable_value(idDetentFlexMctHigh), get_named_variable_value(idDetentTogaLow),
                      get_named_variable_value(idDetentTogaHigh));
  return true;
}

bool ThrottleAxisMapping::loadFromFile() {
  INIReader configuration(CONFIGURATION_FILEPATH);
  if (configuration.ParseError() < 0) {
    // reading failed -> set default config?
    return false;
  }

  // read basic configuration
  useReverseOnAxis = configuration.GetBoolean(CONFIGURATION_SECTION_COMMON, "REVERSE_ON_AXIS", false);

  // read mapping from file
  double reverseLow = configuration.GetReal(CONFIGURATION_SECTION_AXIS, "REVERSE_LOW", -1.00);
  double reverseHigh = configuration.GetReal(CONFIGURATION_SECTION_AXIS, "REVERSE_HIGH", -0.95);
  double reverseIdleLow = configuration.GetReal(CONFIGURATION_SECTION_AXIS, "REVERSE_IDLE_LOW", -0.20);
  double reverseIdleHigh = configuration.GetReal(CONFIGURATION_SECTION_AXIS, "REVERSE_IDLE_HIGH", -0.15);
  double idleLow = configuration.GetReal(CONFIGURATION_SECTION_AXIS, "IDLE_LOW", useReverseOnAxis ? 0.00 : -1.00);
  double idleHigh = configuration.GetReal(CONFIGURATION_SECTION_AXIS, "IDLE_HIGH", useReverseOnAxis ? 0.05 : -0.95);
  double climbLow = configuration.GetReal(CONFIGURATION_SECTION_AXIS, "CLIMB_LOW", 0.89);
  double climbHigh = configuration.GetReal(CONFIGURATION_SECTION_AXIS, "CLIMB_HIGH", 0.90);
  double flexMctLow = configuration.GetReal(CONFIGURATION_SECTION_AXIS, "FLEX_MCT_LOW", 0.95);
  double flexMctHigh = configuration.GetReal(CONFIGURATION_SECTION_AXIS, "FLEX_MCT_HIGH", 0.96);
  double togaLow = configuration.GetReal(CONFIGURATION_SECTION_AXIS, "TOGA_LOW", 0.99);
  double togaHigh = configuration.GetReal(CONFIGURATION_SECTION_AXIS, "TOGA_HIGH", 1.00);

  // save values to local variables
  setLocalVariables(useReverseOnAxis, reverseLow, reverseHigh, reverseIdleLow, reverseIdleHigh, idleLow, idleHigh,
                    climbLow, climbHigh, flexMctLow, flexMctHigh, togaLow, togaHigh);

  // update configuration
  updateConfiguration(useReverseOnAxis, reverseLow, reverseHigh, reverseIdleLow, reverseIdleHigh, idleLow, idleHigh,
                      climbLow, climbHigh, flexMctLow, flexMctHigh, togaLow, togaHigh);

  // success
  return true;
}

bool ThrottleAxisMapping::saveToFile() {
  return false;
}

void ThrottleAxisMapping::onEventThrottleSet(long value) {
  // maybe there is a difference between SET and SET_EX1 event -> needs to be checked
  if (!useReverseOnAxis && !isReverseToggleActive) {
    isReverseToggleKeyActive = false;
  }
  setCurrentValue(value / 16384.0);
}

void ThrottleAxisMapping::onEventThrottleFull() {
  setCurrentValue(1.0);
}

void ThrottleAxisMapping::onEventThrottleCut() {
  isReverseToggleActive = false;
  isReverseToggleKeyActive = false;
  setCurrentValue(idleValue);
}

void ThrottleAxisMapping::onEventThrottleIncrease() {
  increaseThrottleBy(0.05);
}

void ThrottleAxisMapping::onEventThrottleIncreaseSmall() {
  increaseThrottleBy(0.025);
}

void ThrottleAxisMapping::onEventThrottleDecrease() {
  decreaseThrottleBy(0.05);
}

void ThrottleAxisMapping::onEventThrottleDecreaseSmall() {
  decreaseThrottleBy(0.025);
}

void ThrottleAxisMapping::onEventThrottleSet_10() {
  setThrottlePercent(10.0);
}

void ThrottleAxisMapping::onEventThrottleSet_20() {
  setThrottlePercent(20.0);
}

void ThrottleAxisMapping::onEventThrottleSet_30() {
  setThrottlePercent(30.0);
}

void ThrottleAxisMapping::onEventThrottleSet_40() {
  setThrottlePercent(40.0);
}

void ThrottleAxisMapping::onEventThrottleSet_50() {
  setThrottlePercent(50.0);
}

void ThrottleAxisMapping::onEventThrottleSet_60() {
  setThrottlePercent(60.0);
}

void ThrottleAxisMapping::onEventThrottleSet_70() {
  setThrottlePercent(70.0);
}

void ThrottleAxisMapping::onEventThrottleSet_80() {
  setThrottlePercent(80.0);
}

void ThrottleAxisMapping::onEventThrottleSet_90() {
  setThrottlePercent(90.0);
}

void ThrottleAxisMapping::onEventReverseToggle() {
  isReverseToggleActive = !isReverseToggleActive;
  isReverseToggleKeyActive = isReverseToggleActive;
  setCurrentValue(idleValue);
}

void ThrottleAxisMapping::onEventReverseHold(bool isButtonHold) {
  isReverseToggleActive = isButtonHold;
  isReverseToggleKeyActive = isReverseToggleActive;
  if (!isReverseToggleActive) {
    setCurrentValue(idleValue);
  }
}

void ThrottleAxisMapping::setThrottlePercent(double value) {
  setCurrentValue(idleValue + (value * (fabs(idleValue - 1) / 100.0)));
}

void ThrottleAxisMapping::setCurrentValue(double value) {
  // calculate new TLA
  double newTLA = 0;
  if (!useReverseOnAxis && isReverseToggleActive) {
    newTLA = (TLA_REVERSE / 2.0) * (value + 1.0);
  } else {
    newTLA = thrustLeverAngleMapping.get(value);
  }

  // ensure not in reverse when in flight
  if (inFlight) {
    newTLA = max(TLA_IDLE, currentTLA);
  }

  // set values
  currentValue = value;
  currentTLA = newTLA;

  // update local variables
  set_named_variable_value(idInputValue, currentValue);
  set_named_variable_value(idThrustLeverAngle, currentTLA);
}

void ThrottleAxisMapping::increaseThrottleBy(double value) {
  if (!useReverseOnAxis) {
    // check if we have reached the minimum -> toggle reverse
    if (currentValue == -1.0) {
      isReverseToggleKeyActive = !isReverseToggleKeyActive;
    }
  }
  if (isReverseToggleActive | isReverseToggleKeyActive) {
    setCurrentValue(max(-1.0, currentValue - value));
  } else {
    setCurrentValue(min(1.0, currentValue + value));
  }
}

void ThrottleAxisMapping::decreaseThrottleBy(double value) {
  if (!useReverseOnAxis) {
    // check if we have reached the minimum -> toggle reverse
    if (currentValue == -1.0) {
      isReverseToggleKeyActive = !isReverseToggleKeyActive;
    }
  }
  if (isReverseToggleActive | isReverseToggleKeyActive) {
    setCurrentValue(min(1.0, currentValue + value));
  } else {
    setCurrentValue(max(-1.0, currentValue - value));
  }
}

void ThrottleAxisMapping::setLocalVariables(bool shouldUseReverseOnAxis,
                                            double reverseLow,
                                            double reverseHigh,
                                            double reverseIdleLow,
                                            double reverseIdleHigh,
                                            double idleLow,
                                            double idleHigh,
                                            double climbLow,
                                            double climbHigh,
                                            double flxMctLow,
                                            double flxMctHigh,
                                            double togaLow,
                                            double togaHigh) {
  set_named_variable_value(idUseReverseOnAxis, shouldUseReverseOnAxis);
  if (shouldUseReverseOnAxis) {
    set_named_variable_value(idDetentReverseLow, reverseLow);
    set_named_variable_value(idDetentReverseHigh, reverseHigh);
    set_named_variable_value(idDetentReverseIdleLow, reverseIdleLow);
    set_named_variable_value(idDetentReverseIdleHigh, reverseIdleHigh);
  } else {
    set_named_variable_value(idDetentReverseLow, 0.0);
    set_named_variable_value(idDetentReverseHigh, 0.0);
    set_named_variable_value(idDetentReverseIdleLow, 0.0);
    set_named_variable_value(idDetentReverseIdleHigh, 0.0);
  }
  set_named_variable_value(idDetentIdleLow, idleLow);
  set_named_variable_value(idDetentIdleHigh, idleHigh);
  set_named_variable_value(idDetentClimbLow, climbLow);
  set_named_variable_value(idDetentClimbHigh, climbHigh);
  set_named_variable_value(idDetentFlexMctLow, flxMctLow);
  set_named_variable_value(idDetentFlexMctHigh, flxMctHigh);
  set_named_variable_value(idDetentTogaLow, togaLow);
  set_named_variable_value(idDetentTogaHigh, togaHigh);
}

void ThrottleAxisMapping::updateConfiguration(bool shouldUseReverseOnAxis,
                                              double reverseLow,
                                              double reverseHigh,
                                              double reverseIdleLow,
                                              double reverseIdleHigh,
                                              double idleLow,
                                              double idleHigh,
                                              double climbLow,
                                              double climbHigh,
                                              double flxMctLow,
                                              double flxMctHigh,
                                              double togaLow,
                                              double togaHigh) {
  // update use reverse on axis
  useReverseOnAxis = shouldUseReverseOnAxis;

  // mapping table vector
  vector<pair<double, double>> mappingTable;

  if (shouldUseReverseOnAxis) {
    // reverse
    mappingTable.emplace_back(reverseLow, TLA_REVERSE);
    mappingTable.emplace_back(reverseHigh, TLA_REVERSE);
    // reverse idle
    mappingTable.emplace_back(reverseIdleLow, TLA_REVERSE_IDLE);
    mappingTable.emplace_back(reverseIdleHigh, TLA_REVERSE_IDLE);
  }
  // idle
  mappingTable.emplace_back(idleLow, TLA_IDLE);
  mappingTable.emplace_back(idleHigh, TLA_IDLE);
  // climb
  mappingTable.emplace_back(climbLow, TLA_CLIMB);
  mappingTable.emplace_back(climbHigh, TLA_CLIMB);
  // flex / mct
  mappingTable.emplace_back(flxMctLow, TLA_FLEX_MCT);
  mappingTable.emplace_back(flxMctHigh, TLA_FLEX_MCT);
  // toga
  mappingTable.emplace_back(togaLow, TLA_TOGA);
  mappingTable.emplace_back(togaHigh, TLA_TOGA);

  // update interpolation lookup table
  thrustLeverAngleMapping.initialize(mappingTable, TLA_REVERSE, TLA_TOGA);

  // remember idle setting
  idleValue = idleLow;
}

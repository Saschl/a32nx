use crate::shared::interpolation;
use crate::simulation::{
    InitContext, SimulationElement, SimulationElementVisitor, SimulatorWriter, UpdateContext,
    VariableIdentifier, Write,
};
use std::time::Duration;
use uom::si::{
    angle::{degree, radian},
    angular_velocity::radian_per_second,
    area::square_meter,
    f64::*,
    length::meter,
    pressure::psi,
    ratio::ratio,
    velocity::knot,
    volume::{cubic_inch, gallon},
    volume_rate::gallon_per_second,
};
pub trait SteeringController {
    fn requested_position(&self) -> Angle;
}

/// Computes desired angle from a [0;1] steering command
/// Uses an input speed to limit the max commanded steering input
struct SteeringAngleCommandFromSpeed {
    speed_map: [f64; 5],
    angle_output: [f64; 5],
}
impl SteeringAngleCommandFromSpeed {
    fn new(speed_map: [f64; 5], angle_output: [f64; 5]) -> SteeringAngleCommandFromSpeed {
        SteeringAngleCommandFromSpeed {
            speed_map,
            angle_output,
        }
    }

    fn angle_from_speed(&self, speed: Velocity, angle: Angle) -> Angle {
        let max_angle = Angle::new::<degree>(interpolation(
            &self.speed_map,
            &self.angle_output,
            speed.get::<knot>(),
        ));

        if angle.get::<degree>() > 0. {
            max_angle.min(angle)
        } else {
            -max_angle.max(angle)
        }
    }
}

struct SteeringActuator {
    current_speed: AngularVelocity,
    current_position: Angle,

    max_half_angle: Angle,

    max_speed: AngularVelocity,
    nominal_speed: AngularVelocity,

    angular_to_linear_ratio: Ratio,

    total_volume_to_actuator: Volume,
    total_volume_to_reservoir: Volume,

    actuator_area: Area,
}
impl SteeringActuator {
    const MIN_PRESSURE_ALLOWING_STEERING_PSI: f64 = 300.;

    const REFERENCE_PRESS_FOR_NOMINAL_SPEED_PSI: f64 = 2000.;

    fn new(
        max_half_angle: Angle,
        nominal_speed: AngularVelocity,
        actuator_diamter: Length,
        angular_to_linear_ratio: Ratio,
    ) -> Self {
        Self {
            current_speed: AngularVelocity::new::<radian_per_second>(0.),
            current_position: Angle::new::<radian>(0.),

            max_half_angle,

            max_speed: AngularVelocity::new::<radian_per_second>(0.),
            nominal_speed,
            angular_to_linear_ratio,

            total_volume_to_actuator: Volume::new::<gallon>(0.),
            total_volume_to_reservoir: Volume::new::<gallon>(0.),

            actuator_area: std::f64::consts::PI * (actuator_diamter / 2.) * (actuator_diamter / 2.),
        }
    }

    fn update(
        &mut self,
        context: &UpdateContext,
        current_pressure: Pressure,
        steering_controller: &impl SteeringController,
    ) {
        self.update_max_speed(current_pressure);

        let limited_requested_angle = steering_controller
            .requested_position()
            .min(self.max_half_angle)
            .max(-self.max_half_angle);

        if limited_requested_angle > self.position_feedback() {
            self.current_speed = 0.8 * self.current_speed + 0.2 * self.max_speed;
        } else if limited_requested_angle < self.position_feedback() {
            self.current_speed = 0.8 * self.current_speed + 0.2 * -self.max_speed;
        } else {
            self.current_speed = AngularVelocity::new::<radian_per_second>(0.);
        }
        self.current_position += Angle::new::<radian>(
            self.current_speed.get::<radian_per_second>() * context.delta_as_secs_f64(),
        );

        if self.current_speed.get::<radian_per_second>() > 0.
            && limited_requested_angle < self.position_feedback()
            || self.current_speed.get::<radian_per_second>() < 0.
                && limited_requested_angle > self.position_feedback()
        {
            self.current_speed = AngularVelocity::new::<radian_per_second>(0.);
            self.current_position = limited_requested_angle;
        }

        self.update_flow(context, current_pressure);
    }

    fn update_max_speed(&mut self, current_pressure: Pressure) {
        let new_max_speed =
            if current_pressure.get::<psi>() > Self::MIN_PRESSURE_ALLOWING_STEERING_PSI {
                self.nominal_speed * current_pressure.get::<psi>().sqrt() * 1.
                    / Self::REFERENCE_PRESS_FOR_NOMINAL_SPEED_PSI.sqrt()
            } else {
                AngularVelocity::new::<radian_per_second>(0.)
            };

        self.max_speed = 0.5 * self.max_speed + 0.5 * new_max_speed;
    }

    fn update_flow(&mut self, context: &UpdateContext, current_pressure: Pressure) {
        let angular_position_delta = Angle::new::<radian>(
            self.current_speed.get::<radian_per_second>() * context.delta_as_secs_f64(),
        );

        let linear_position_delta = Length::new::<meter>(
            angular_position_delta.get::<radian>() * self.angular_to_linear_ratio.get::<ratio>(),
        );

        // TODO different if unpressurised by pushback pin
        self.total_volume_to_actuator = linear_position_delta * self.actuator_area;
        self.total_volume_to_reservoir = linear_position_delta * self.actuator_area;
    }

    fn position_feedback(&self) -> Angle {
        self.current_position
    }
}

#[cfg(test)]
mod tests {

    use super::*;

    use crate::simulation::test::{SimulationTestBed, TestBed};
    use crate::simulation::{Aircraft, SimulationElement};
    use std::time::Duration;
    use uom::si::{angle::degree, pressure::psi};

    struct TestSteeringController {
        requested_position: Angle,
    }
    impl TestSteeringController {
        fn new() -> Self {
            Self {
                requested_position: Angle::new::<radian>(0.),
            }
        }

        fn set_requested_position(&mut self, requested_position: Angle) {
            self.requested_position = requested_position;
        }
    }
    impl SteeringController for TestSteeringController {
        fn requested_position(&self) -> Angle {
            self.requested_position
        }
    }

    struct TestAircraft {
        steering_actuator: SteeringActuator,

        controller: TestSteeringController,

        pressure: Pressure,
    }
    impl TestAircraft {
        fn new(steering_actuator: SteeringActuator) -> Self {
            Self {
                steering_actuator,

                controller: TestSteeringController::new(),

                pressure: Pressure::new::<psi>(0.),
            }
        }

        fn set_pressure(&mut self, pressure: Pressure) {
            self.pressure = pressure;
        }

        fn command_steer_angle(&mut self, angle: Angle) {
            self.controller.set_requested_position(angle);
        }
    }
    impl Aircraft for TestAircraft {
        fn update_after_power_distribution(&mut self, context: &UpdateContext) {
            self.steering_actuator
                .update(context, self.pressure, &self.controller);

            println!(
                "Steering feedback {:.3} deg, Speed {:.3} rad/s, Target {:.1} deg , Pressure {:.0}",
                self.steering_actuator.position_feedback().get::<degree>(),
                self.steering_actuator
                    .current_speed
                    .get::<radian_per_second>(),
                self.controller.requested_position().get::<degree>(),
                self.pressure.get::<psi>()
            );
        }
    }
    impl SimulationElement for TestAircraft {}

    #[test]
    fn init_with_zero_angle() {
        let mut test_bed = SimulationTestBed::new(|_| TestAircraft::new(steering_actuator()));

        let actuator_position_init = test_bed.query(|a| a.steering_actuator.position_feedback());

        test_bed.run_multiple_frames(Duration::from_secs(1));

        assert!(
            test_bed.query(|a| a.steering_actuator.position_feedback()) == actuator_position_init
        );
    }

    #[test]
    fn steering_not_moving_without_pressure() {
        let mut test_bed = SimulationTestBed::new(|_| TestAircraft::new(steering_actuator()));

        let actuator_position_init = test_bed.query(|a| a.steering_actuator.position_feedback());
        test_bed.command(|a| a.set_pressure(Pressure::new::<psi>(0.)));
        test_bed.command(|a| a.command_steer_angle(Angle::new::<degree>(90.)));

        test_bed.run_multiple_frames(Duration::from_secs(1));

        assert!(
            test_bed.query(|a| a.steering_actuator.position_feedback()) == actuator_position_init
        );

        test_bed.command(|a| a.command_steer_angle(Angle::new::<degree>(-90.)));

        test_bed.run_multiple_frames(Duration::from_secs(1));

        assert!(
            test_bed.query(|a| a.steering_actuator.position_feedback()) == actuator_position_init
        );
    }

    #[test]
    fn steering_moving_with_pressure_to_max_pos_less_than_3s() {
        let mut test_bed = SimulationTestBed::new(|_| TestAircraft::new(steering_actuator()));

        test_bed.command(|a| a.set_pressure(Pressure::new::<psi>(3000.)));
        test_bed.command(|a| a.command_steer_angle(Angle::new::<degree>(90.)));

        test_bed.run_multiple_frames(Duration::from_secs(3));

        assert!(
            test_bed.query(|a| a.steering_actuator.position_feedback())
                >= Angle::new::<degree>(74.)
        );
        assert!(
            test_bed.query(|a| a.steering_actuator.position_feedback())
                <= Angle::new::<degree>(76.)
        );

        test_bed.command(|a| a.command_steer_angle(Angle::new::<degree>(-90.)));
        test_bed.run_multiple_frames(Duration::from_secs(6));

        assert!(
            test_bed.query(|a| a.steering_actuator.position_feedback())
                >= Angle::new::<degree>(-76.)
        );
        assert!(
            test_bed.query(|a| a.steering_actuator.position_feedback())
                <= Angle::new::<degree>(-74.)
        );
    }

    #[test]
    fn steering_moving_only_by_6_deg_at_20_knot() {
        let mut test_bed = SimulationTestBed::new(|_| TestAircraft::new(steering_actuator()));

        let angle_limiter = pedal_steer_command();

        test_bed.command(|a| a.set_pressure(Pressure::new::<psi>(3000.)));
        test_bed.command(|a| {
            a.command_steer_angle(
                angle_limiter
                    .angle_from_speed(Velocity::new::<knot>(20.), Angle::new::<degree>(90.)),
            )
        });

        test_bed.run_multiple_frames(Duration::from_secs(3));

        assert!(
            test_bed.query(|a| a.steering_actuator.position_feedback()) >= Angle::new::<degree>(5.)
        );
        assert!(
            test_bed.query(|a| a.steering_actuator.position_feedback()) <= Angle::new::<degree>(7.)
        );

        test_bed.command(|a| {
            a.command_steer_angle(
                angle_limiter
                    .angle_from_speed(Velocity::new::<knot>(20.), Angle::new::<degree>(-90.)),
            )
        });

        test_bed.run_multiple_frames(Duration::from_secs(6));

        assert!(
            test_bed.query(|a| a.steering_actuator.position_feedback())
                >= Angle::new::<degree>(-7.)
        );
        assert!(
            test_bed.query(|a| a.steering_actuator.position_feedback())
                <= Angle::new::<degree>(-5.)
        );
    }

    fn steering_actuator() -> SteeringActuator {
        SteeringActuator::new(
            Angle::new::<degree>(75.),
            AngularVelocity::new::<radian_per_second>(0.5),
            Length::new::<meter>(0.15),
            Ratio::new::<ratio>(0.15),
        )
    }

    fn pedal_steer_command() -> SteeringAngleCommandFromSpeed {
        const speed_map: [f64; 5] = [0., 40., 130., 1500.0, 2800.0];
        const steering_angle: [f64; 5] = [6., 6., 0., 0., 0.];

        SteeringAngleCommandFromSpeed::new(speed_map, steering_angle)
    }
}

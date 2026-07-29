use std::{cell::Cell, rc::Rc, time::Duration};
use uom::si::{f64::Ratio, ratio::percent};

use crate::{
    shared::random_from_range,
    simulation::{
        InitContext, Read, Reader, SimulationElement, SimulationElementVisitor,
        SimulationInputCommand, SimulatorReader, SimulatorWriter, VariableIdentifier, Write,
        Writer,
    },
};
use nalgebra::Vector3;
use uom::si::{f64::Mass, mass::kilogram, mass::pound};

pub struct LoadsheetInfo {
    pub operating_empty_weight_kg: f64,
    pub operating_empty_position: (f64, f64, f64),
    pub per_pax_weight_kg: f64,
    pub mean_aerodynamic_chord_size: f64,
    pub leading_edge_mean_aerodynamic_chord: f64,
}

pub struct PaxInfo<'a> {
    pub max_pax: i8,
    pub position: (f64, f64, f64),
    pub pax_id: &'a str,
    pub payload_id: &'a str,
}
pub struct CargoInfo<'a> {
    pub max_cargo_kg: f64,
    pub position: (f64, f64, f64),
    pub cargo_id: &'a str,
    pub payload_id: &'a str,
}

pub trait NumberOfPassengers {
    fn number_of_passengers(&self, ps: usize) -> i8;
}

pub trait PassengerPayload {
    fn total_passenger_load(&self) -> Mass;
    fn total_target_passenger_load(&self) -> Mass;

    fn center_of_gravity(&self) -> Vector3<f64>;
    fn fore_aft_center_of_gravity(&self) -> f64;
    fn target_center_of_gravity(&self) -> Vector3<f64>;
    fn target_fore_aft_center_of_gravity(&self) -> f64;
}

pub trait CargoPayload {
    fn total_cargo_load(&self) -> Mass;
    fn total_target_cargo_load(&self) -> Mass;

    fn center_of_gravity(&self) -> Vector3<f64>;
    fn fore_aft_center_of_gravity(&self) -> f64;
    fn target_center_of_gravity(&self) -> Vector3<f64>;
    fn target_fore_aft_center_of_gravity(&self) -> f64;
}

#[derive(Debug)]
pub struct BoardingAgent<const P: usize> {
    door_id: Option<VariableIdentifier>,
    door_open_ratio: Ratio,
    order: [usize; P],
}
impl<const P: usize> BoardingAgent<P> {
    pub fn new(door_id: Option<VariableIdentifier>, order: [usize; P]) -> Self {
        BoardingAgent {
            door_id,
            order,
            door_open_ratio: Ratio::default(),
        }
    }

    pub fn handle_one_pax(&self, pax: &mut [Pax; P]) {
        for ps in self.order {
            if self.is_door_open() {
                if pax[ps].pax_is_target() {
                    continue;
                }
                pax[ps].move_one_pax();
                break;
            }
        }
    }

    pub fn force_one_pax(&self, pax: &mut [Pax; P]) {
        for ps in self.order {
            if pax[ps].pax_is_target() {
                continue;
            }
            pax[ps].move_one_pax();
            break;
        }
    }

    pub fn force_num_pax(&self, num_to_move: i32, pax: &mut [Pax; P]) {
        for _ in 0..num_to_move {
            self.force_one_pax(pax);
        }
    }

    pub fn is_door_open(&self) -> bool {
        self.door_open_ratio >= Ratio::new::<percent>(100.)
    }
}
impl<const P: usize> SimulationElement for BoardingAgent<P> {
    fn read(&mut self, reader: &mut SimulatorReader) {
        self.door_open_ratio = self
            .door_id
            .map(|door_id| reader.read(&door_id))
            .unwrap_or_default();
    }
}

#[derive(Debug)]
pub struct PassengerDeck<const N: usize, const G: usize> {
    pax: [Pax; N],
    default_boarding_agent: BoardingAgent<N>,
    boarding_agents: [BoardingAgent<N>; G],
}
impl<const N: usize, const G: usize> PassengerDeck<N, G> {
    pub fn new(
        pax: [Pax; N],
        default_boarding_agent: BoardingAgent<N>,
        boarding_agents: [BoardingAgent<N>; G],
    ) -> Self {
        PassengerDeck {
            pax,
            default_boarding_agent,
            boarding_agents,
        }
    }

    fn pax_num(&self, ps: usize) -> i8 {
        self.pax[ps].pax_num()
    }

    fn total_pax_num(&self) -> i32 {
        self.pax.iter().map(|ps| ps.pax_num() as i32).sum()
    }

    fn total_target_pax_num(&self) -> i32 {
        self.pax.iter().map(|ps| ps.pax_target_num() as i32).sum()
    }

    fn pax_payload(&self, ps: usize) -> Mass {
        self.pax[ps].payload()
    }

    fn pax_target_payload(&self, ps: usize) -> Mass {
        self.pax[ps].payload_target()
    }

    fn max_pax(&self, ps: usize) -> i8 {
        self.pax[ps].max_pax()
    }

    fn max_total_pax(&self) -> i32 {
        self.pax.iter().map(|ps| ps.max_pax() as i32).sum()
    }

    fn set_target_pax_num(&mut self, ps: usize, pax_target: i8) {
        self.pax[ps].set_pax_target_num(pax_target);
    }

    fn set_target_pax_bits(&mut self, ps: usize, pax_target: u64) -> bool {
        if let Some(pax_station) = self.pax.get_mut(ps) {
            pax_station.set_pax_target_bits(pax_target);
            true
        } else {
            false
        }
    }

    fn toggle_target_seat(&mut self, ps: usize, seat_id: usize) -> bool {
        if let Some(pax_station) = self.pax.get_mut(ps) {
            pax_station.toggle_target_seat(seat_id)
        } else {
            false
        }
    }

    fn has_pax(&self) -> bool {
        self.pax.iter().any(|ps| ps.pax_num() > 0)
    }

    fn total_passenger_load(&self) -> Mass {
        self.pax.iter().map(|ps| ps.payload()).sum()
    }

    fn total_target_passenger_load(&self) -> Mass {
        self.pax.iter().map(|ps| ps.payload_target()).sum()
    }

    fn total_passenger_moment(&self) -> Vector3<f64> {
        self.pax.iter().map(|ps| ps.pax_moment()).sum()
    }

    fn total_target_passenger_moment(&self) -> Vector3<f64> {
        self.pax.iter().map(|ps| ps.pax_target_moment()).sum()
    }

    fn is_pax_boarding(&self, is_door_open: bool) -> bool {
        is_door_open && self.pax.iter().any(|ps| ps.pax_num() < ps.pax_target_num())
    }

    fn is_pax_deboarding(&self, is_door_open: bool) -> bool {
        is_door_open && self.pax.iter().any(|ps| ps.pax_num() > ps.pax_target_num())
    }

    fn is_pax_loaded(&self) -> bool {
        self.pax.iter().all(|ps| ps.pax_is_target())
    }

    fn override_payload(&mut self, ps: usize, payload: Mass) {
        self.pax[ps].override_payload(payload);
    }

    fn target_none(&mut self) {
        for cs in &mut self.pax {
            cs.reset_pax_target();
        }
    }

    fn update_one_tick(&mut self) {
        let doors_open = self.boarding_agents.iter().any(|ba| ba.is_door_open());
        if doors_open {
            for boarding_agent in &mut self.boarding_agents {
                boarding_agent.handle_one_pax(&mut self.pax);
            }
        } else {
            self.default_boarding_agent.force_one_pax(&mut self.pax);
        }
    }

    fn spawn_all_pax(&mut self) {
        for ps in &mut self.pax {
            if ps.pax_is_target() {
                continue;
            }
            ps.spawn_pax();
        }
    }

    fn board_pax_until_target(&mut self, pax_target: i32) {
        let pax_diff = pax_target - self.total_pax_num();
        if pax_diff > 0 {
            let mut available_agents = self
                .boarding_agents
                .iter()
                .filter(|ba| ba.is_door_open())
                .peekable();

            if available_agents.peek().is_some() {
                for boarding_agent in available_agents.cycle().take(pax_diff as usize) {
                    boarding_agent.handle_one_pax(&mut self.pax);
                }
            } else {
                self.default_boarding_agent
                    .force_num_pax(pax_diff, &mut self.pax);
            }
        }
    }

    fn deboard_pax_until_target(&mut self, pax_target: i32) {
        let pax_diff = self.total_pax_num() - pax_target;
        if pax_diff > 0 {
            self.default_boarding_agent
                .force_num_pax(pax_diff, &mut self.pax);
        }
    }
}

impl<const N: usize, const G: usize> SimulationElement for PassengerDeck<N, G> {
    fn accept<T: SimulationElementVisitor>(&mut self, visitor: &mut T) {
        accept_iterable!(self.pax, visitor);
        accept_iterable!(self.boarding_agents, visitor);

        visitor.visit(self);
    }
}

pub struct CargoDeck<const N: usize> {
    cargo: [Cargo; N],
}
impl<const N: usize> CargoDeck<N> {
    pub fn new(cargo: [Cargo; N]) -> Self {
        CargoDeck { cargo }
    }

    pub fn station(&self, cs: usize) -> &Cargo {
        &self.cargo[cs]
    }

    fn cargo(&self, cs: usize) -> Mass {
        self.cargo[cs].cargo()
    }

    fn cargo_payload(&self, cs: usize) -> Mass {
        self.cargo[cs].payload()
    }

    fn total_cargo_load(&self) -> Mass {
        self.cargo.iter().map(|cs| cs.cargo()).sum()
    }

    fn total_target_cargo_load(&self) -> Mass {
        self.cargo.iter().map(|cs| cs.cargo_target()).sum()
    }

    fn total_cargo_moment(&self) -> Vector3<f64> {
        self.cargo.iter().map(|cs| cs.cargo_moment()).sum()
    }

    fn total_target_cargo_moment(&self) -> Vector3<f64> {
        self.cargo.iter().map(|cs| cs.cargo_target_moment()).sum()
    }

    fn max_cargo(&self, cs: usize) -> Mass {
        self.cargo[cs].max_capacity()
    }

    fn max_total_cargo(&self) -> Mass {
        self.cargo.iter().map(|cs| cs.max_capacity()).sum()
    }

    fn set_target_cargo(&mut self, cs: usize, target_cargo: Mass) {
        self.cargo[cs].set_cargo_target(target_cargo);
    }

    fn is_cargo_loaded(&self) -> bool {
        self.cargo.iter().all(|cs| cs.cargo_is_target())
    }

    fn update_cargo_loaded(&mut self) {
        for cargo in &mut self.cargo {
            cargo.update_cargo_loaded()
        }
    }

    fn reset_cargo_loaded(&mut self) {
        for cargo in &mut self.cargo {
            cargo.reset_cargo_loaded()
        }
    }

    fn load_cargo_deck_percent(&mut self, p: f64) {
        for cs in &mut self.cargo {
            cs.load_cargo_percent(p);
        }
    }

    fn target_none(&mut self) {
        for cs in &mut self.cargo {
            cs.reset_cargo_target();
        }
    }

    fn move_one_cargo(&mut self) {
        for cs in &mut self.cargo {
            if cs.cargo_is_target() {
                continue;
            }
            cs.move_one_cargo();
            break;
        }
    }

    fn spawn_all_cargo(&mut self) {
        for cs in &mut self.cargo {
            if cs.cargo_is_target() {
                continue;
            }
            cs.spawn_cargo();
        }
    }
}

impl<const N: usize> SimulationElement for CargoDeck<N> {
    fn accept<T: SimulationElementVisitor>(&mut self, visitor: &mut T) {
        accept_iterable!(self.cargo, visitor);

        visitor.visit(self);
    }
}

#[derive(Debug)]
pub struct Pax {
    pax_id: VariableIdentifier,
    pax_target_id: VariableIdentifier,
    payload_id: VariableIdentifier,
    developer_state: Rc<Cell<i8>>,
    per_pax_weight: Rc<Cell<Mass>>,
    pax_target: u64,
    pax: u64,

    payload: Mass,

    position: Vector3<f64>,
    max: i8,
}
impl Pax {
    const JS_MAX_SAFE_INTEGER: i8 = 53;

    pub fn new(
        pax_id: VariableIdentifier,
        pax_target_id: VariableIdentifier,
        payload_id: VariableIdentifier,
        developer_state: Rc<Cell<i8>>,
        per_pax_weight: Rc<Cell<Mass>>,
        position: Vector3<f64>,
        max: i8,
    ) -> Self {
        Pax {
            pax_id,
            pax_target_id,
            developer_state,
            per_pax_weight,
            payload_id,
            pax_target: 0,
            pax: 0,
            payload: Mass::default(),
            position,
            max,
        }
    }

    fn is_developer_state_active(&self) -> bool {
        self.developer_state.get() > 0
    }

    pub fn per_pax_weight(&self) -> Mass {
        self.per_pax_weight.get()
    }

    pub fn pax_is_target(&self) -> bool {
        self.pax == self.pax_target
    }

    pub fn pax(&self) -> u64 {
        self.pax
    }

    pub fn pax_num(&self) -> i8 {
        self.pax.count_ones() as i8
    }

    pub fn pax_target_num(&self) -> i8 {
        self.pax_target.count_ones() as i8
    }

    pub fn max_pax(&self) -> i8 {
        self.max
    }

    pub fn payload(&self) -> Mass {
        self.payload
    }

    pub fn payload_target(&self) -> Mass {
        Mass::new::<pound>(self.pax_target_num() as f64 * self.per_pax_weight().get::<pound>())
    }

    pub fn pax_moment(&self) -> Vector3<f64> {
        self.pax_num() as f64 * self.per_pax_weight().get::<kilogram>() * self.position
    }

    pub fn pax_target_moment(&self) -> Vector3<f64> {
        self.pax_target_num() as f64 * self.per_pax_weight().get::<kilogram>() * self.position
    }

    pub fn payload_is_sync(&self) -> bool {
        self.payload
            == Mass::new::<pound>(self.pax_num() as f64 * self.per_pax_weight().get::<pound>())
    }

    pub fn override_payload(&mut self, payload: Mass) {
        self.payload = payload;
    }

    pub fn load_payload(&mut self) {
        self.payload =
            Mass::new::<pound>(self.pax_num() as f64 * self.per_pax_weight().get::<pound>());
    }

    pub fn spawn_pax(&mut self) {
        self.pax = self.pax_target;
        self.load_payload();
    }

    pub fn move_num_pax(&mut self, pax: i8) {
        for _ in 0..pax {
            self.move_one_pax();
        }
    }

    pub fn move_one_pax(&mut self) {
        let pax_diff = self.pax_target_num() - self.pax_num();

        let n = if pax_diff > 0 {
            !self.pax & self.pax_target
        } else {
            self.pax & !self.pax_target
        };
        let count = n.count_ones() as f64;
        if count > 0. {
            let mut skip = random_from_range(0., count) as i8;

            for i in 0..Self::JS_MAX_SAFE_INTEGER {
                let bit = 1 << i;
                if (n & bit) > 0 {
                    if skip <= 0 {
                        self.pax ^= bit;
                        break;
                    }
                    skip -= 1;
                }
            }
        }
        self.load_payload();
    }

    pub fn reset_pax_target(&mut self) {
        self.pax_target = 0;
    }

    pub fn set_pax_target_num(&mut self, pax_target: i8) {
        let target = pax_target.clamp(0, self.max) as u32;
        self.pax_target = if target == 0 {
            0
        } else {
            (1_u64 << target) - 1
        };
    }

    pub fn set_pax_target_bits(&mut self, pax_target: u64) {
        let seat_mask = if self.max as u32 >= u64::BITS {
            u64::MAX
        } else {
            (1_u64 << self.max) - 1
        };
        self.pax_target = pax_target & seat_mask;
    }

    pub fn toggle_target_seat(&mut self, seat_id: usize) -> bool {
        if seat_id >= self.max as usize || seat_id >= Self::JS_MAX_SAFE_INTEGER as usize {
            return false;
        }

        self.pax_target ^= 1_u64 << seat_id;
        true
    }
}
impl SimulationElement for Pax {
    fn read(&mut self, reader: &mut SimulatorReader) {
        self.pax = reader.read(&self.pax_id);
        //  self.pax_target = reader.read(&self.pax_target_id);
        self.payload = reader.read(&self.payload_id);
        if !self.is_developer_state_active() && !self.payload_is_sync() {
            self.load_payload()
        }
    }
    fn write(&self, writer: &mut SimulatorWriter) {
        writer.write(&self.pax_id, self.pax);
        writer.write(&self.pax_target_id, self.pax_target);
        writer.write(&self.payload_id, self.payload.get::<pound>());
    }
}

#[derive(Debug)]
pub struct Cargo {
    cargo_target_id: VariableIdentifier,
    cargo_id: VariableIdentifier,
    payload_id: VariableIdentifier,
    cargo: Mass,
    cargo_loaded: Mass,
    cargo_target: Mass,
    developer_state: Rc<Cell<i8>>,
    payload: Mass,

    position: Vector3<f64>,
    max_capacity: Mass,
}
impl Cargo {
    const MAX_CARGO_MOVE: f64 = 60.;

    pub fn new(
        cargo_id: VariableIdentifier,
        cargo_target_id: VariableIdentifier,
        payload_id: VariableIdentifier,
        developer_state: Rc<Cell<i8>>,
        position: Vector3<f64>,
        max_capacity: Mass,
    ) -> Self {
        Cargo {
            cargo_id,
            cargo_target_id,
            payload_id,
            cargo: Mass::default(),
            cargo_loaded: Mass::default(),
            cargo_target: Mass::default(),
            developer_state,
            payload: Mass::default(),
            position,
            max_capacity,
        }
    }

    fn is_developer_state_active(&self) -> bool {
        self.developer_state.get() > 0
    }

    pub fn cargo(&self) -> Mass {
        self.cargo
    }

    pub fn cargo_target(&self) -> Mass {
        self.cargo_target
    }

    pub fn max_capacity(&self) -> Mass {
        self.max_capacity
    }

    pub fn update_cargo_loaded(&mut self) {
        self.cargo_loaded = self.cargo
    }

    pub fn reset_cargo_loaded(&mut self) {
        self.cargo_loaded = Mass::default()
    }

    pub fn payload(&self) -> Mass {
        self.payload
    }

    pub fn payload_is_sync(&self) -> bool {
        self.payload == self.cargo
    }

    pub fn cargo_moment(&self) -> Vector3<f64> {
        self.cargo.get::<kilogram>() * self.position
    }

    pub fn cargo_target_moment(&self) -> Vector3<f64> {
        self.cargo_target.get::<kilogram>() * self.position
    }

    pub fn cargo_is_target(&self) -> bool {
        self.cargo == self.cargo_target
    }

    pub fn load_payload(&mut self) {
        self.payload = self.cargo;
    }

    pub fn spawn_cargo(&mut self) {
        self.cargo = self.cargo_target;
        self.load_payload();
    }

    pub fn move_one_cargo(&mut self) {
        let max_move = Self::MAX_CARGO_MOVE;
        let cargo_delta =
            f64::abs(self.cargo_target.get::<kilogram>() - self.cargo.get::<kilogram>());

        let qty = Mass::new::<kilogram>(f64::min(cargo_delta, max_move));

        if self.cargo < self.cargo_target {
            self.cargo += qty;
        } else if self.cargo > self.cargo_target {
            self.cargo -= qty;
        }
        self.load_payload();
    }

    pub fn load_cargo_percent(&mut self, p: f64) {
        if self.cargo_loaded.get::<kilogram>() > 0. {
            self.cargo = self.cargo_loaded * (p / 100.)
        } else {
            self.cargo = (p / 100.) * self.cargo_target;
        }
        self.load_payload();
    }

    pub fn reset_cargo_target(&mut self) {
        self.cargo_target = Mass::default();
    }

    pub fn set_cargo_target(&mut self, target_cargo: Mass) {
        let clamped_target = target_cargo
            .get::<kilogram>()
            .clamp(0., self.max_capacity.get::<kilogram>());
        self.cargo_target = Mass::new::<kilogram>(clamped_target);
    }
}
impl SimulationElement for Cargo {
    fn accept<T: SimulationElementVisitor>(&mut self, visitor: &mut T) {
        visitor.visit(self);
    }
    fn read(&mut self, reader: &mut SimulatorReader) {
        self.cargo = Mass::new::<kilogram>(reader.read(&self.cargo_id));
        // cargo_target is owned by the backend now (set via input commands); reading it
        // back from the LVar would overwrite freshly applied commands with the stale value.
        // self.cargo_target = Mass::new::<kilogram>(reader.read(&self.cargo_target_id));
        self.payload = reader.read(&self.payload_id);
        if !self.is_developer_state_active() && !self.payload_is_sync() {
            self.load_payload()
        }
    }
    fn write(&self, writer: &mut SimulatorWriter) {
        writer.write(&self.cargo_id, self.cargo.get::<kilogram>());
        writer.write(&self.cargo_target_id, self.cargo_target.get::<kilogram>());
        writer.write(&self.payload_id, self.payload);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BoardingRate {
    Instant,
    Fast,
    Real,
}
try_read_write_enum!(BoardingRate);
impl TryFrom<f64> for BoardingRate {
    type Error = u8;

    fn try_from(value: f64) -> Result<Self, Self::Error> {
        match value as u8 {
            0 => Ok(BoardingRate::Instant),
            1 => Ok(BoardingRate::Fast),
            2 => Ok(BoardingRate::Real),
            i => Err(i),
        }
    }
}

pub struct BoardingSounds {
    pax_board_id: VariableIdentifier,
    pax_deboard_id: VariableIdentifier,
    pax_complete_id: VariableIdentifier,
    pax_ambience_id: VariableIdentifier,

    pax_boarding: bool,
    pax_deboarding: bool,
    pax_complete: bool,
    pax_ambience: bool,
}
impl BoardingSounds {
    pub fn new(context: &mut InitContext) -> Self {
        BoardingSounds {
            pax_board_id: context.get_identifier("SOUND_PAX_BOARDING".to_owned()),
            pax_deboard_id: context.get_identifier("SOUND_PAX_DEBOARDING".to_owned()),
            pax_complete_id: context.get_identifier("SOUND_BOARDING_COMPLETE".to_owned()),
            pax_ambience_id: context.get_identifier("SOUND_PAX_AMBIENCE".to_owned()),
            pax_boarding: false,
            pax_deboarding: false,
            pax_complete: false,
            pax_ambience: false,
        }
    }

    fn pax_boarding(&self) -> bool {
        self.pax_boarding
    }

    fn pax_deboarding(&self) -> bool {
        self.pax_deboarding
    }

    fn pax_complete(&self) -> bool {
        self.pax_complete
    }

    fn pax_ambience(&self) -> bool {
        self.pax_ambience
    }

    pub fn play_sound_pax_boarding(&mut self, playing: bool) {
        self.pax_boarding = playing;
    }

    pub fn play_sound_pax_deboarding(&mut self, playing: bool) {
        self.pax_deboarding = playing;
    }

    pub fn play_sound_pax_complete(&mut self, playing: bool) {
        self.pax_complete = playing;
    }

    pub fn play_sound_pax_ambience(&mut self, playing: bool) {
        self.pax_ambience = playing;
    }

    pub fn stop_boarding_sounds(&mut self) {
        self.pax_boarding = false;
        self.pax_deboarding = false;
        self.pax_complete = false;
    }
}
impl SimulationElement for BoardingSounds {
    fn write(&self, writer: &mut SimulatorWriter) {
        writer.write(&self.pax_board_id, self.pax_boarding);
        writer.write(&self.pax_deboard_id, self.pax_deboarding);
        writer.write(&self.pax_complete_id, self.pax_complete);
        writer.write(&self.pax_ambience_id, self.pax_ambience);
    }
}

pub struct PayloadManager<const P: usize, const G: usize, const C: usize> {
    time: Duration,
    fast_rate: u16,
    real_rate: u16,
    boarding_inputs: BoardingInputs,
    boarding_sounds: BoardingSounds,
    passenger_deck: PassengerDeck<P, G>,
    cargo_deck: CargoDeck<C>,
    gsx_driver: GsxDriver,
    handled_target_pax: Option<i32>,
    handled_seat_click_cmd: Option<i64>,
    handled_target_cargo_kg: Option<f64>,
    handled_target_zfw_kg: Option<f64>,
    handled_target_gw_kg: Option<f64>,
}
impl<const P: usize, const G: usize, const C: usize> PayloadManager<P, G, C> {
    const SEAT_CLICK_CMD_STATION_FACTOR: i64 = 1000;
    const SEAT_CLICK_CMD_SEQ_FACTOR: i64 = 1_000_000;
    const PAX_STATION_TARGET_CMD_PREFIX: &'static str = "WB_PAX_STATION_TARGET_";
    const CARGO_STATION_TARGET_CMD_PREFIX: &'static str = "WB_CARGO_STATION_TARGET_";

    pub fn new(
        context: &mut InitContext,
        per_pax_weight: Rc<Cell<Mass>>,
        developer_state: Rc<Cell<i8>>,
        boarding_sounds: BoardingSounds,
        passenger_deck: PassengerDeck<P, G>,
        cargo_deck: CargoDeck<C>,
        fast_rate: u16,
        real_rate: u16,
    ) -> Self {
        PayloadManager {
            time: Duration::default(),
            boarding_inputs: BoardingInputs::new(context, per_pax_weight, developer_state),
            boarding_sounds,
            gsx_driver: GsxDriver::new(context),
            passenger_deck,
            cargo_deck,
            fast_rate,
            real_rate,
            handled_target_pax: None,
            handled_seat_click_cmd: None,
            handled_target_cargo_kg: None,
            handled_target_zfw_kg: None,
            handled_target_gw_kg: None,
        }
    }

    fn time(&self) -> Duration {
        self.time
    }

    pub fn is_boarding_allowed(&self) -> bool {
        self.boarding_inputs.is_boarding()
    }

    pub fn board_rate(&self) -> BoardingRate {
        self.boarding_inputs.board_rate()
    }

    // ======================================

    pub fn pax_num(&self, ps: usize) -> i8 {
        self.passenger_deck.pax_num(ps)
    }

    pub fn total_pax_num(&self) -> i32 {
        self.passenger_deck.total_pax_num()
    }

    pub fn total_passenger_load(&self) -> Mass {
        self.passenger_deck.total_passenger_load()
    }

    pub fn total_target_passenger_load(&self) -> Mass {
        self.passenger_deck.total_target_passenger_load()
    }

    pub fn total_passenger_moment(&self) -> Vector3<f64> {
        self.passenger_deck.total_passenger_moment()
    }

    pub fn total_target_passenger_moment(&self) -> Vector3<f64> {
        self.passenger_deck.total_target_passenger_moment()
    }

    pub fn total_cargo_load(&self) -> Mass {
        self.cargo_deck.total_cargo_load()
    }

    pub fn total_target_cargo_load(&self) -> Mass {
        self.cargo_deck.total_target_cargo_load()
    }

    pub fn total_cargo_moment(&self) -> Vector3<f64> {
        self.cargo_deck.total_cargo_moment()
    }

    pub fn total_target_cargo_moment(&self) -> Vector3<f64> {
        self.cargo_deck.total_target_cargo_moment()
    }

    // ======================================

    pub fn max_pax(&self, ps: usize) -> i8 {
        self.passenger_deck.max_pax(ps)
    }

    pub fn pax_payload(&self, ps: usize) -> Mass {
        self.passenger_deck.pax_payload(ps)
    }

    pub fn pax_target_payload(&self, ps: usize) -> Mass {
        self.passenger_deck.pax_target_payload(ps)
    }

    pub fn cargo(&self, ps: usize) -> Mass {
        self.cargo_deck.cargo(ps)
    }

    pub fn cargo_payload(&self, cs: usize) -> Mass {
        self.cargo_deck.cargo_payload(cs)
    }

    pub fn max_cargo(&self, cs: usize) -> Mass {
        self.cargo_deck.max_cargo(cs)
    }

    pub fn sound_pax_boarding_playing(&self) -> bool {
        self.boarding_sounds.pax_boarding()
    }

    pub fn sound_pax_ambience_playing(&self) -> bool {
        self.boarding_sounds.pax_ambience()
    }

    pub fn sound_pax_complete_playing(&self) -> bool {
        self.boarding_sounds.pax_complete()
    }

    pub fn sound_pax_deboarding_playing(&self) -> bool {
        self.boarding_sounds.pax_deboarding()
    }

    // ======================================

    fn has_pax(&self) -> bool {
        self.passenger_deck.has_pax()
    }
    fn is_pax_boarding(&self) -> bool {
        self.passenger_deck
            .is_pax_boarding(self.is_boarding_allowed())
    }
    fn is_pax_deboarding(&self) -> bool {
        self.passenger_deck
            .is_pax_deboarding(self.is_boarding_allowed())
    }
    fn is_pax_loaded(&self) -> bool {
        self.passenger_deck.is_pax_loaded()
    }
    fn is_cargo_loaded(&self) -> bool {
        self.cargo_deck.is_cargo_loaded()
    }

    fn is_fully_loaded(&self) -> bool {
        self.is_pax_loaded() && self.is_cargo_loaded()
    }

    // ======================================

    fn update_time(&mut self, delta_time: Duration) {
        self.time += delta_time;
    }

    fn reset_time(&mut self) {
        self.time = Duration::default()
    }

    fn emit_stop_boarding(&mut self) {
        self.boarding_inputs.stop_boarding();
    }

    // ======================================

    fn spawn_all_pax(&mut self) {
        self.passenger_deck.spawn_all_pax();
    }

    fn update_one_tick(&mut self) {
        self.passenger_deck.update_one_tick();
    }

    pub fn override_pax_payload(&mut self, ps: usize, payload: Mass) {
        self.passenger_deck.override_payload(ps, payload)
    }

    fn spawn_all_cargo(&mut self) {
        self.cargo_deck.spawn_all_cargo();
    }

    fn update_one_cargo(&mut self) {
        self.cargo_deck.move_one_cargo();
    }

    fn update_pax_tick(&mut self) {
        match self.board_rate() {
            BoardingRate::Instant => self.spawn_all_pax(),
            BoardingRate::Fast => self.update_one_tick(),
            BoardingRate::Real => self.update_one_tick(),
        }
    }

    fn update_cargo_tick(&mut self) {
        match self.board_rate() {
            BoardingRate::Instant => self.spawn_all_cargo(),
            BoardingRate::Fast => self.update_one_cargo(),
            BoardingRate::Real => self.update_one_cargo(),
        }
    }

    fn update_pax_ambience(&mut self) {
        self.boarding_sounds.play_sound_pax_ambience(self.has_pax());
    }

    fn distribute_target_pax(&mut self, requested_pax: i32) -> i32 {
        let max_total_pax = self.passenger_deck.max_total_pax();
        let target_pax = requested_pax.clamp(0, max_total_pax);

        let max_total_pax_f64 = f64::max(max_total_pax as f64, 1.);

        let mut station_targets = [0_i32; P];
        let mut pax_remaining = target_pax;

        for station in 0..P {
            let station_max = self.passenger_deck.max_pax(station) as i32;
            let station_ratio = station_max as f64 / max_total_pax_f64;
            let station_target = (station_ratio * target_pax as f64)
                .floor()
                .clamp(0., station_max as f64) as i32;

            station_targets[station] = station_target;
            pax_remaining -= station_target;
        }

        // Flooring per station leaves up to P-1 pax unassigned; hand them out
        // round-robin to stations with free seats so no requested pax is dropped.
        while pax_remaining > 0 {
            let mut assigned = false;
            for station in 0..P {
                if pax_remaining == 0 {
                    break;
                }
                if station_targets[station] < self.passenger_deck.max_pax(station) as i32 {
                    station_targets[station] += 1;
                    pax_remaining -= 1;
                    assigned = true;
                }
            }
            if !assigned {
                break;
            }
        }

        for station in 0..P {
            self.passenger_deck
                .set_target_pax_num(station, station_targets[station] as i8);
        }

        target_pax
    }

    fn apply_target_pax(&mut self, requested_pax: i32) {
        let old_target_pax = self.passenger_deck.total_target_pax_num() as f64;
        let old_target_cargo_kg = self.cargo_deck.total_target_cargo_load().get::<kilogram>();
        let per_bag_weight_kg = self.boarding_inputs.per_bag_weight().get::<kilogram>();
        let retained_freight_kg =
            f64::max(old_target_cargo_kg - old_target_pax * per_bag_weight_kg, 0.);

        println!(
            "Applying target pax: requested={}, old_target={}, retained_freight_kg={}",
            requested_pax, old_target_pax, retained_freight_kg
        );
        let target_pax = self.distribute_target_pax(requested_pax);
        self.boarding_inputs.set_target_pax(target_pax);

        let target_cargo_kg = target_pax as f64 * per_bag_weight_kg + retained_freight_kg;
        self.boarding_inputs.set_target_zfw_kg(
            target_pax as f64 * self.boarding_inputs.per_pax_weight().get::<kilogram>()
                + target_cargo_kg,
        );
        self.apply_target_cargo(Mass::new::<kilogram>(target_cargo_kg));
        self.boarding_inputs
            .set_target_cargo_kg(self.cargo_deck.total_target_cargo_load().get::<kilogram>());
    }

    fn apply_seat_click_command(&mut self, seat_click_cmd: i64) -> Option<i32> {
        if seat_click_cmd < 0 {
            return None;
        }

        let station_and_seat = seat_click_cmd % Self::SEAT_CLICK_CMD_SEQ_FACTOR;
        let station = (station_and_seat / Self::SEAT_CLICK_CMD_STATION_FACTOR) as usize;
        let seat = (station_and_seat % Self::SEAT_CLICK_CMD_STATION_FACTOR) as usize;

        if !self.passenger_deck.toggle_target_seat(station, seat) {
            return None;
        }

        let target_pax = self.passenger_deck.total_target_pax_num();
        self.boarding_inputs.set_target_pax(target_pax);
        Some(target_pax)
    }

    fn apply_target_zfw(&mut self, requested_zfw_kg: f64) {
        let empty_weight_kg = f64::max(
            self.boarding_inputs.airframe_zfw_kg()
                - self.total_passenger_load().get::<kilogram>()
                - self.total_cargo_load().get::<kilogram>(),
            0.,
        );

        let max_total_cargo_kg = self.cargo_deck.max_total_cargo().get::<kilogram>();
        let max_total_pax = self.passenger_deck.max_total_pax();
        let per_pax_weight_kg = self.boarding_inputs.per_pax_weight().get::<kilogram>();
        let per_bag_weight_kg = self.boarding_inputs.per_bag_weight().get::<kilogram>();
        let per_pax_total_kg = per_pax_weight_kg + per_bag_weight_kg;

        if per_pax_total_kg <= 0. {
            return;
        }

        let mut payload_weight_kg = requested_zfw_kg - empty_weight_kg;
        let target_pax = (payload_weight_kg / per_pax_total_kg)
            .round()
            .clamp(0., max_total_pax as f64) as i32;

        payload_weight_kg -= target_pax as f64 * per_pax_total_kg;
        let freight_weight_kg = payload_weight_kg.clamp(0., max_total_cargo_kg);
        let total_cargo_weight_kg = (target_pax as f64 * per_bag_weight_kg + freight_weight_kg)
            .clamp(0., max_total_cargo_kg);

        self.distribute_target_pax(target_pax);
        self.apply_target_cargo(Mass::new::<kilogram>(total_cargo_weight_kg));
        self.boarding_inputs.set_target_pax(target_pax);
        self.boarding_inputs
            .set_target_cargo_kg(total_cargo_weight_kg);
    }

    fn apply_target_gw(&mut self, requested_gw_kg: f64) {
        let empty_weight_kg = f64::max(
            self.boarding_inputs.airframe_zfw_kg()
                - self.total_passenger_load().get::<kilogram>()
                - self.total_cargo_load().get::<kilogram>(),
            0.,
        );

        let fuel_weight_kg = f64::max(
            self.boarding_inputs.airframe_gw_kg() - self.boarding_inputs.airframe_zfw_kg(),
            0.,
        );
        let max_total_cargo_kg = self.cargo_deck.max_total_cargo().get::<kilogram>();
        let max_total_pax = self.passenger_deck.max_total_pax();
        let per_pax_weight_kg = self.boarding_inputs.per_pax_weight().get::<kilogram>();
        let per_bag_weight_kg = self.boarding_inputs.per_bag_weight().get::<kilogram>();
        let per_pax_total_kg = per_pax_weight_kg + per_bag_weight_kg;

        if per_pax_total_kg <= 0. {
            return;
        }

        let mut payload_weight_kg = requested_gw_kg - empty_weight_kg - fuel_weight_kg;
        let target_pax = (payload_weight_kg / per_pax_total_kg)
            .round()
            .clamp(0., max_total_pax as f64) as i32;

        payload_weight_kg -= target_pax as f64 * per_pax_total_kg;
        let freight_weight_kg = payload_weight_kg.clamp(0., max_total_cargo_kg);
        let total_cargo_weight_kg = (target_pax as f64 * per_bag_weight_kg + freight_weight_kg)
            .clamp(0., max_total_cargo_kg);

        self.distribute_target_pax(target_pax);
        self.apply_target_cargo(Mass::new::<kilogram>(total_cargo_weight_kg));
        self.boarding_inputs.set_target_pax(target_pax);
        self.boarding_inputs
            .set_target_cargo_kg(total_cargo_weight_kg);
    }

    fn apply_target_cargo(&mut self, requested_cargo: Mass) {
        let max_total_cargo_kg = self.cargo_deck.max_total_cargo().get::<kilogram>();
        let target_cargo_kg = requested_cargo
            .get::<kilogram>()
            .clamp(0., max_total_cargo_kg);

        let mut cargo_remaining_kg = target_cargo_kg;

        for station in (1..C).rev() {
            let station_max = self.cargo_deck.max_cargo(station).get::<kilogram>();
            let station_ratio = if max_total_cargo_kg > 0. {
                station_max / max_total_cargo_kg
            } else {
                0.
            };
            let station_target = (station_ratio * target_cargo_kg)
                .round()
                .clamp(0., station_max);

            cargo_remaining_kg -= station_target;
            self.cargo_deck
                .set_target_cargo(station, Mass::new::<kilogram>(station_target));
        }

        if C > 0 {
            let first_station_max = self.cargo_deck.max_cargo(0).get::<kilogram>();
            let first_station_target = cargo_remaining_kg.clamp(0., first_station_max);
            self.cargo_deck
                .set_target_cargo(0, Mass::new::<kilogram>(first_station_target));
        }
    }

    fn process_payload_input_commands(&mut self) {
        let seat_click_cmd = self.boarding_inputs.seat_click_cmd();
        if self
            .handled_seat_click_cmd
            .is_some_and(|handled_seat_click_cmd| handled_seat_click_cmd != seat_click_cmd)
        {
            if let Some(target_pax) = self.apply_seat_click_command(seat_click_cmd) {
                self.handled_target_pax = Some(target_pax);
            }
        }
        self.handled_seat_click_cmd = Some(seat_click_cmd);

        let target_pax = self.boarding_inputs.target_pax();
        if self
            .handled_target_pax
            .is_some_and(|handled_target_pax| handled_target_pax != target_pax)
        {
            self.apply_target_pax(self.boarding_inputs.target_pax());
        }
        self.handled_target_pax = Some(self.boarding_inputs.target_pax());

        let target_cargo_kg = self.boarding_inputs.target_cargo_kg();
        if self
            .handled_target_cargo_kg
            .is_some_and(|handled_target_cargo_kg| {
                f64::abs(handled_target_cargo_kg - target_cargo_kg) > f64::EPSILON
            })
        {
            self.apply_target_cargo(Mass::new::<kilogram>(target_cargo_kg));
        }
        self.handled_target_cargo_kg = Some(target_cargo_kg);

        let target_zfw_kg = self.boarding_inputs.target_zfw_kg();
        if self
            .handled_target_zfw_kg
            .is_some_and(|handled_target_zfw_kg| {
                f64::abs(handled_target_zfw_kg - target_zfw_kg) > f64::EPSILON
            })
        {
            self.apply_target_zfw(target_zfw_kg);
        }
        self.handled_target_zfw_kg = Some(target_zfw_kg);

        let target_gw_kg = self.boarding_inputs.target_gw_kg();
        if self
            .handled_target_gw_kg
            .is_some_and(|handled_target_gw_kg| {
                f64::abs(handled_target_gw_kg - target_gw_kg) > f64::EPSILON
            })
        {
            self.apply_target_gw(target_gw_kg);
        }
        self.handled_target_gw_kg = Some(target_gw_kg);
    }

    fn process_external_input_command(&mut self, command: &SimulationInputCommand) {
        println!(
            "Received command: {} with value {}",
            command.name, command.value
        );
        match command.name.as_str() {
            "BOARDING_STARTED_BY_USR" => {
                self.boarding_inputs.set_is_boarding(command.value > 0.);
            }
            "BOARDING_RATE" => {
                let board_rate = match command.value.round() as i32 {
                    2 => BoardingRate::Real,
                    1 => BoardingRate::Fast,
                    _ => BoardingRate::Instant,
                };
                self.boarding_inputs.set_board_rate(board_rate);
            }
            "WB_PER_PAX_WEIGHT" => {
                self.boarding_inputs
                    .set_per_pax_weight(Mass::new::<kilogram>(command.value.max(0.)));
            }
            "WB_PER_BAG_WEIGHT" => {
                self.boarding_inputs
                    .set_per_bag_weight(Mass::new::<kilogram>(command.value.max(0.)));
            }
            "WB_TARGET_PAX" => {
                let target_pax = command.value.round() as i32;
                self.apply_target_pax(target_pax);
                self.handled_target_pax = Some(self.boarding_inputs.target_pax());
            }
            "WB_SEAT_CLICK_CMD" => {
                let seat_click_cmd = command.value.round() as i64;
                self.boarding_inputs.set_seat_click_cmd(seat_click_cmd);
                if let Some(target_pax) = self.apply_seat_click_command(seat_click_cmd) {
                    self.handled_target_pax = Some(target_pax);
                }
                self.handled_seat_click_cmd = Some(seat_click_cmd);
            }
            "WB_TARGET_CARGO_KG" => {
                let target_cargo_kg = command.value.max(0.);
                self.boarding_inputs.set_target_cargo_kg(target_cargo_kg);
                self.apply_target_cargo(Mass::new::<kilogram>(target_cargo_kg));
                self.handled_target_cargo_kg = Some(target_cargo_kg);
            }
            "WB_TARGET_ZFW_KG" => {
                let target_zfw_kg = command.value.max(0.);
                self.boarding_inputs.set_target_zfw_kg(target_zfw_kg);
                self.apply_target_zfw(target_zfw_kg);
                self.handled_target_zfw_kg = Some(target_zfw_kg);
            }
            "WB_TARGET_GW_KG" => {
                let target_gw_kg = command.value.max(0.);
                self.boarding_inputs.set_target_gw_kg(target_gw_kg);
                self.apply_target_gw(target_gw_kg);
                self.handled_target_gw_kg = Some(target_gw_kg);
            }
            _ if command
                .name
                .starts_with(Self::PAX_STATION_TARGET_CMD_PREFIX) =>
            {
                let station = command
                    .name
                    .strip_prefix(Self::PAX_STATION_TARGET_CMD_PREFIX)
                    .and_then(|station| station.parse::<usize>().ok());
                if let Some(station) = station {
                    // The value is the desired seat occupancy bitflag for the station.
                    if self
                        .passenger_deck
                        .set_target_pax_bits(station, command.value.max(0.) as u64)
                    {
                        let target_pax = self.passenger_deck.total_target_pax_num();
                        self.boarding_inputs.set_target_pax(target_pax);
                        self.handled_target_pax = Some(target_pax);
                    }
                }
            }
            _ if command
                .name
                .starts_with(Self::CARGO_STATION_TARGET_CMD_PREFIX) =>
            {
                let station = command
                    .name
                    .strip_prefix(Self::CARGO_STATION_TARGET_CMD_PREFIX)
                    .and_then(|station| station.parse::<usize>().ok());
                if let Some(station) = station {
                    self.cargo_deck
                        .set_target_cargo(station, Mass::new::<kilogram>(command.value.max(0.)));
                    self.boarding_inputs.set_target_cargo_kg(
                        self.cargo_deck.total_target_cargo_load().get::<kilogram>(),
                    );
                    self.handled_target_cargo_kg = Some(self.boarding_inputs.target_cargo_kg());
                }
            }
            _ => {}
        }
    }

    fn update_boarding_sounds(&mut self) {
        self.boarding_sounds
            .play_sound_pax_boarding(self.is_pax_boarding() && !self.is_pax_deboarding());
        self.boarding_sounds
            .play_sound_pax_deboarding(self.is_pax_deboarding() && !self.is_pax_boarding());
        self.boarding_sounds.play_sound_pax_complete(
            self.has_pax() && self.is_pax_loaded() && self.is_boarding_allowed(),
        )
    }

    fn stop_boarding_sounds(&mut self) {
        self.boarding_sounds.stop_boarding_sounds()
    }

    // ======================================
    pub fn update(&mut self, delta_time: Duration) {
        //self.process_payload_input_commands();
        self.update_pax_ambience();

        if !self.gsx_driver.is_enabled() {
            if !self.is_boarding_allowed() {
                self.reset_time();
                self.stop_boarding_sounds();
                return;
            }
            let ms_delay = if self.board_rate() == BoardingRate::Instant {
                0
            } else if self.board_rate() == BoardingRate::Fast {
                self.fast_rate.into()
            } else {
                self.real_rate.into()
            };
            self.update_time(delta_time);

            if self.time().as_millis() > ms_delay {
                self.reset_time();
                self.update_pax_tick();
                self.update_cargo_tick();
            }
            self.update_boarding_sounds();
            if self.is_fully_loaded() {
                self.emit_stop_boarding();
            }
        } else {
            self.emit_stop_boarding();
            self.stop_boarding_sounds();
            self.gsx_driver.update(
                &mut self.passenger_deck,
                &mut self.cargo_deck,
                &mut self.boarding_sounds,
            )
        }
    }
}
impl<const P: usize, const G: usize, const C: usize> SimulationElement for PayloadManager<P, G, C> {
    fn accept<T: SimulationElementVisitor>(&mut self, visitor: &mut T) {
        self.boarding_inputs.accept(visitor);
        self.passenger_deck.accept(visitor);
        self.cargo_deck.accept(visitor);
        self.boarding_sounds.accept(visitor);
        self.gsx_driver.accept(visitor);

        visitor.visit(self);
    }

    fn receive_input_command(&mut self, command: &SimulationInputCommand) {
        self.process_external_input_command(command);
    }
}

pub struct BoardingInputs {
    developer_state_id: VariableIdentifier,
    is_boarding_id: VariableIdentifier,
    board_rate_id: VariableIdentifier,
    per_pax_weight_id: VariableIdentifier,
    per_bag_weight_id: VariableIdentifier,
    airframe_zfw_id: VariableIdentifier,
    airframe_gw_id: VariableIdentifier,
    target_pax_id: VariableIdentifier,
    seat_click_cmd_id: VariableIdentifier,
    target_cargo_id: VariableIdentifier,
    target_zfw_id: VariableIdentifier,
    target_gw_id: VariableIdentifier,

    developer_state: Rc<Cell<i8>>,
    is_boarding: bool,
    board_rate: BoardingRate,
    per_pax_weight: Rc<Cell<Mass>>,
    per_bag_weight: Mass,
    airframe_zfw_kg: f64,
    airframe_gw_kg: f64,
    target_pax: i32,
    seat_click_cmd: i64,
    target_cargo_kg: f64,
    target_zfw_kg: f64,
    target_gw_kg: f64,
}
impl BoardingInputs {
    pub fn new(
        context: &mut InitContext,
        per_pax_weight: Rc<Cell<Mass>>,
        developer_state: Rc<Cell<i8>>,
    ) -> Self {
        BoardingInputs {
            developer_state_id: context.get_identifier("DEVELOPER_STATE".to_owned()),
            is_boarding_id: context.get_identifier("BOARDING_STARTED_BY_USR".to_owned()),
            board_rate_id: context.get_identifier("BOARDING_RATE".to_owned()),
            per_pax_weight_id: context.get_identifier("WB_PER_PAX_WEIGHT".to_owned()),
            per_bag_weight_id: context.get_identifier("WB_PER_BAG_WEIGHT".to_owned()),
            airframe_zfw_id: context.get_identifier("AIRFRAME_ZFW".to_owned()),
            airframe_gw_id: context.get_identifier("AIRFRAME_GW".to_owned()),
            target_pax_id: context.get_identifier("WB_TARGET_PAX".to_owned()),
            seat_click_cmd_id: context.get_identifier("WB_SEAT_CLICK_CMD".to_owned()),
            target_cargo_id: context.get_identifier("WB_TARGET_CARGO_KG".to_owned()),
            target_zfw_id: context.get_identifier("WB_TARGET_ZFW_KG".to_owned()),
            target_gw_id: context.get_identifier("WB_TARGET_GW_KG".to_owned()),

            developer_state,
            is_boarding: false,
            board_rate: BoardingRate::Instant,
            per_pax_weight,
            per_bag_weight: Mass::default(),
            airframe_zfw_kg: 0.,
            airframe_gw_kg: 0.,
            target_pax: 0,
            seat_click_cmd: 0,
            target_cargo_kg: 0.,
            target_zfw_kg: 0.,
            target_gw_kg: 0.,
        }
    }

    pub fn is_developer_state_active(&self) -> bool {
        self.developer_state.get() > 0
    }

    pub fn is_boarding(&self) -> bool {
        self.is_boarding
    }

    pub fn board_rate(&self) -> BoardingRate {
        self.board_rate
    }

    pub fn stop_boarding(&mut self) {
        self.is_boarding = false;
    }

    pub fn set_is_boarding(&mut self, is_boarding: bool) {
        self.is_boarding = is_boarding;
    }

    pub fn set_board_rate(&mut self, board_rate: BoardingRate) {
        self.board_rate = board_rate;
    }

    pub fn per_pax_weight(&self) -> Mass {
        self.per_pax_weight.get()
    }

    pub fn set_per_pax_weight(&mut self, per_pax_weight: Mass) {
        self.per_pax_weight.set(per_pax_weight);
    }

    pub fn per_bag_weight(&self) -> Mass {
        self.per_bag_weight
    }

    pub fn set_per_bag_weight(&mut self, per_bag_weight: Mass) {
        self.per_bag_weight = per_bag_weight;
    }

    pub fn target_pax(&self) -> i32 {
        self.target_pax
    }

    pub fn set_target_pax(&mut self, target_pax: i32) {
        self.target_pax = target_pax.max(0);
    }

    pub fn seat_click_cmd(&self) -> i64 {
        self.seat_click_cmd
    }

    pub fn set_seat_click_cmd(&mut self, seat_click_cmd: i64) {
        self.seat_click_cmd = seat_click_cmd.max(0);
    }

    pub fn target_cargo_kg(&self) -> f64 {
        self.target_cargo_kg
    }

    pub fn set_target_cargo_kg(&mut self, target_cargo_kg: f64) {
        self.target_cargo_kg = target_cargo_kg.max(0.);
    }

    pub fn target_zfw_kg(&self) -> f64 {
        self.target_zfw_kg
    }

    pub fn set_target_zfw_kg(&mut self, target_zfw_kg: f64) {
        self.target_zfw_kg = target_zfw_kg.max(0.);
    }

    pub fn target_gw_kg(&self) -> f64 {
        self.target_gw_kg
    }

    pub fn set_target_gw_kg(&mut self, target_gw_kg: f64) {
        self.target_gw_kg = target_gw_kg.max(0.);
    }

    pub fn airframe_zfw_kg(&self) -> f64 {
        self.airframe_zfw_kg
    }

    pub fn airframe_gw_kg(&self) -> f64 {
        self.airframe_gw_kg
    }
}
impl SimulationElement for BoardingInputs {
    fn read(&mut self, reader: &mut SimulatorReader) {
        self.developer_state
            .set(reader.read(&self.developer_state_id));
        // self.is_boarding = reader.read(&self.is_boarding_id);
        // self.board_rate = reader.read(&self.board_rate_id);
        // self.per_pax_weight.set(Mass::new::<kilogram>(reader.read(&self.per_pax_weight_id)));
        //self.per_bag_weight = Mass::new::<kilogram>(reader.read(&self.per_bag_weight_id));
        self.airframe_zfw_kg = reader.read(&self.airframe_zfw_id);
        self.airframe_gw_kg = reader.read(&self.airframe_gw_id);

        let target_pax: f64 = reader.read(&self.target_pax_id);

        //  self.target_pax = target_pax.round() as i32;
        //  let seat_click_cmd: f64 = reader.read(&self.seat_click_cmd_id);
        //  self.seat_click_cmd = seat_click_cmd.round() as i64;
        //self.target_cargo_kg = reader.read(&self.target_cargo_id);
        // self.target_zfw_kg = reader.read(&self.target_zfw_id);
        // self.target_gw_kg = reader.read(&self.target_gw_id);
    }

    fn write(&self, writer: &mut SimulatorWriter) {
        writer.write(&self.is_boarding_id, self.is_boarding);
        writer.write(&self.board_rate_id, self.board_rate);
        writer.write(
            &self.per_pax_weight_id,
            self.per_pax_weight().get::<kilogram>(),
        );
        writer.write(
            &self.per_bag_weight_id,
            self.per_bag_weight().get::<kilogram>(),
        );
        writer.write(&self.target_pax_id, self.target_pax as f64);
        //  writer.write(&self.seat_click_cmd_id, self.seat_click_cmd as f64);
        writer.write(&self.target_cargo_id, self.target_cargo_kg);
        writer.write(&self.target_zfw_id, self.target_zfw_kg);
        writer.write(&self.target_gw_id, self.target_gw_kg);
    }
}

// ========================================
// GSX Integration
// ========================================

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GsxState {
    None,
    Available,
    NotAvailable,
    Bypassed,
    Requested,
    Performing,
    Completed,
}

impl TryFrom<f64> for GsxState {
    type Error = u8;

    fn try_from(value: f64) -> Result<Self, Self::Error> {
        match value as u8 {
            0 => Ok(GsxState::None),
            1 => Ok(GsxState::Available),
            2 => Ok(GsxState::NotAvailable),
            3 => Ok(GsxState::Bypassed),
            4 => Ok(GsxState::Requested),
            5 => Ok(GsxState::Performing),
            6 => Ok(GsxState::Completed),
            7 => Ok(GsxState::Completed),
            unexpected => Err(unexpected),
        }
    }
}

try_read_write_enum!(GsxState);

pub struct GsxInput {
    is_enabled_id: VariableIdentifier,
    boarding_state_id: VariableIdentifier,
    deboarding_state_id: VariableIdentifier,
    pax_boarding_id: VariableIdentifier,
    pax_deboarding_id: VariableIdentifier,
    cargo_boarding_percent_id: VariableIdentifier,
    cargo_deboarding_percent_id: VariableIdentifier,

    is_enabled: bool,
    boarding_state: GsxState,
    deboarding_state: GsxState,
    pax_boarding: i32,
    pax_deboarding: i32,
    cargo_boarding_percent: f64,
    cargo_deboarding_percent: f64,
}
impl GsxInput {
    pub fn new(context: &mut InitContext) -> Self {
        GsxInput {
            is_enabled_id: context.get_identifier("GSX_PAYLOAD_SYNC_ENABLED".to_owned()),
            boarding_state_id: context.get_identifier("FSDT_GSX_BOARDING_STATE".to_owned()),
            deboarding_state_id: context.get_identifier("FSDT_GSX_DEBOARDING_STATE".to_owned()),
            pax_boarding_id: context
                .get_identifier("FSDT_GSX_NUMPASSENGERS_BOARDING_TOTAL".to_owned()),
            pax_deboarding_id: context
                .get_identifier("FSDT_GSX_NUMPASSENGERS_DEBOARDING_TOTAL".to_owned()),
            cargo_boarding_percent_id: context
                .get_identifier("FSDT_GSX_BOARDING_CARGO_PERCENT".to_owned()),
            cargo_deboarding_percent_id: context
                .get_identifier("FSDT_GSX_DEBOARDING_CARGO_PERCENT".to_owned()),
            is_enabled: false,
            boarding_state: GsxState::None,
            deboarding_state: GsxState::None,
            pax_boarding: 0,
            pax_deboarding: 0,
            cargo_boarding_percent: 0.0,
            cargo_deboarding_percent: 0.0,
        }
    }

    fn is_enabled(&self) -> bool {
        self.is_enabled
    }

    fn boarding_state(&self) -> GsxState {
        self.boarding_state
    }

    fn deboarding_state(&self) -> GsxState {
        self.deboarding_state
    }

    fn pax_boarding(&self) -> i32 {
        self.pax_boarding
    }

    fn pax_deboarding(&self) -> i32 {
        self.pax_deboarding
    }
}
impl SimulationElement for GsxInput {
    fn read(&mut self, reader: &mut SimulatorReader) {
        self.is_enabled = reader.read(&self.is_enabled_id);
        self.pax_boarding = reader.read(&self.pax_boarding_id);
        self.pax_deboarding = reader.read(&self.pax_deboarding_id);
        self.cargo_boarding_percent = reader.read(&self.cargo_boarding_percent_id);
        self.cargo_deboarding_percent = reader.read(&self.cargo_deboarding_percent_id);
        self.boarding_state = reader.read_discrete_or_fallback(
            &self.boarding_state_id,
            "boarding_state",
            GsxState::Completed,
        );
        self.deboarding_state = reader.read_discrete_or_fallback(
            &self.deboarding_state_id,
            "deboarding_state",
            GsxState::Completed,
        );
    }
}

pub struct GsxDriver {
    gsx_input: GsxInput,
    performing_board: bool,
    performing_deboard: bool,
    deboarding_total: i32,
}
impl GsxDriver {
    pub fn new(context: &mut InitContext) -> Self {
        GsxDriver {
            gsx_input: GsxInput::new(context),
            performing_board: false,
            performing_deboard: false,
            deboarding_total: 0,
        }
    }

    fn is_enabled(&self) -> bool {
        self.gsx_input.is_enabled()
    }

    fn deboarding_state(&self) -> GsxState {
        self.gsx_input.deboarding_state()
    }

    fn boarding_state(&self) -> GsxState {
        self.gsx_input.boarding_state()
    }

    fn has_pax<const P: usize, const G: usize>(
        &self,
        passenger_deck: &PassengerDeck<P, G>,
    ) -> bool {
        passenger_deck.has_pax()
    }

    fn pax_boarding(&self) -> i32 {
        self.gsx_input.pax_boarding()
    }

    fn pax_deboarding(&self) -> i32 {
        self.gsx_input.pax_deboarding()
    }

    fn cargo_boarding_percent(&self) -> f64 {
        self.gsx_input.cargo_boarding_percent
    }

    fn cargo_deboarding_percent(&self) -> f64 {
        self.gsx_input.cargo_deboarding_percent
    }

    pub fn update<const P: usize, const G: usize, const C: usize>(
        &mut self,
        passenger_deck: &mut PassengerDeck<P, G>,
        cargo_deck: &mut CargoDeck<C>,
        boarding_sounds: &mut BoardingSounds,
    ) {
        self.update_boarding_sounds(passenger_deck, boarding_sounds);
        self.update_boarding(passenger_deck, cargo_deck);
        self.update_deboarding(passenger_deck, cargo_deck);
    }

    fn update_boarding_sounds<const P: usize, const G: usize>(
        &mut self,
        passenger_deck: &PassengerDeck<P, G>,
        boarding_sounds: &mut BoardingSounds,
    ) {
        boarding_sounds.play_sound_pax_boarding(self.boarding_state() == GsxState::Performing);
        boarding_sounds.play_sound_pax_deboarding(self.deboarding_state() == GsxState::Performing);
        boarding_sounds.play_sound_pax_ambience(self.has_pax(passenger_deck));
        boarding_sounds.play_sound_pax_complete(self.boarding_state() == GsxState::Completed)
    }

    fn update_boarding<const P: usize, const G: usize, const C: usize>(
        &mut self,
        passenger_deck: &mut PassengerDeck<P, G>,
        cargo_deck: &mut CargoDeck<C>,
    ) {
        match self.boarding_state() {
            GsxState::None
            | GsxState::Available
            | GsxState::NotAvailable
            | GsxState::Bypassed
            | GsxState::Requested => {
                self.performing_board = false;
            }
            GsxState::Completed => {
                if self.performing_board {
                    passenger_deck.spawn_all_pax();
                    cargo_deck.spawn_all_cargo();
                }
                self.performing_board = false;
            }
            GsxState::Performing => {
                passenger_deck.board_pax_until_target(self.pax_boarding());
                cargo_deck.load_cargo_deck_percent(self.cargo_boarding_percent());
                self.performing_board = true;
            }
        }
    }

    fn update_deboarding<const P: usize, const G: usize, const C: usize>(
        &mut self,
        passenger_deck: &mut PassengerDeck<P, G>,
        cargo_deck: &mut CargoDeck<C>,
    ) {
        match self.deboarding_state() {
            GsxState::None | GsxState::Available | GsxState::NotAvailable | GsxState::Bypassed => {
                self.deboarding_total = 0;
                self.performing_deboard = false;
            }
            GsxState::Requested => {
                cargo_deck.update_cargo_loaded();
                passenger_deck.target_none();
                cargo_deck.target_none();
                self.deboarding_total = passenger_deck.total_pax_num();
                self.performing_deboard = false;
            }
            GsxState::Completed => {
                if self.performing_deboard {
                    passenger_deck.spawn_all_pax();
                    cargo_deck.spawn_all_cargo();
                    cargo_deck.reset_cargo_loaded();
                    cargo_deck.target_none();
                }
                self.deboarding_total = 0;
                self.performing_deboard = false;
            }
            GsxState::Performing => {
                passenger_deck
                    .deboard_pax_until_target(self.deboarding_total - self.pax_deboarding());
                cargo_deck.load_cargo_deck_percent(100. - self.cargo_deboarding_percent());
                self.performing_deboard = true;
            }
        }
    }
}
impl SimulationElement for GsxDriver {
    fn accept<T: SimulationElementVisitor>(&mut self, visitor: &mut T) {
        self.gsx_input.accept(visitor);
        visitor.visit(self);
    }
}

// @ts-strict-ignore
// Copyright (c) 2021-2024 FlyByWire Simulations
//
// SPDX-License-Identifier: GPL-3.0

import {
  Arinc429ConsumerSubject,
  Arinc429LocalVarConsumerSubject,
  Arinc429Register,
  Arinc429RegisterSubject,
  Arinc429WordData,
  ArincEventBus,
} from '@flybywiresim/fbw-sdk';
import { ClockEvents, ConsumerSubject, Instrument, MathUtils, Publisher, Subscription } from '@microsoft/msfs-sdk';

import { PFDSimvars } from './PFDSimvarPublisher';
import { FcuBus } from './FcuBusProvider';
import { LagFilter } from '../PFDUtils';
import { getDisplayIndex } from '../PFD';

export interface Arinc429Values {
  pitchAr: Arinc429WordData;
  rollAr: Arinc429WordData;

  /** The "displayed altitude" in feet. It's baro corrected for QFE/QNH modes, otherwise pressure alt. */
  altitudeAr: Arinc429WordData;

  magTrack: Arinc429WordData;
  magHeading: Arinc429WordData;
  speedAr: Arinc429WordData;
  machAr: Arinc429WordData;
  vs: Arinc429WordData;
  gs: Arinc429WordData;
  chosenRa: Arinc429WordData;
  fpa: Arinc429WordData;
  da: Arinc429WordData;
  landingElevation: Arinc429WordData;
  latAcc: Arinc429WordData;
  fcdcDiscreteWord1: Arinc429WordData;
  fcdc1DiscreteWord1: Arinc429WordData;
  fcdc2DiscreteWord1: Arinc429WordData;
  fcdc1DiscreteWord2: Arinc429WordData;
  fcdc2DiscreteWord2: Arinc429WordData;
  fcdcCaptPitchCommand: Arinc429WordData;
  fcdcFoPitchCommand: Arinc429WordData;
  fcdcCaptRollCommand: Arinc429WordData;
  fcdcFoRollCommand: Arinc429WordData;
  facToUse: number;
  vAlphaMax: Arinc429WordData;
  vAlphaProt: Arinc429WordData;
  vStallWarn: Arinc429WordData;
  vMax: Arinc429WordData;
  vFeNext: Arinc429WordData;
  vCTrend: number;
  vMan: Arinc429WordData;
  v4: Arinc429WordData;
  v3: Arinc429WordData;
  vLs: Arinc429WordData;
  estimatedBeta: Arinc429WordData;
  betaTarget: Arinc429WordData;
  irMaintWord: Arinc429WordData;
  trueHeading: Arinc429WordData;
  trueTrack: Arinc429WordData;
  fmEisDiscreteWord1Raw: number;
  fmEisDiscreteWord2Raw: number;
  fmMdaRaw: number;
  fmDhRaw: number;
  fmTransAltRaw: number;
  fmTransLvlRaw: number;
  ecu1MaintenanceWord6: Arinc429WordData;
  ecu2MaintenanceWord6: Arinc429WordData;
}
export class ArincValueProvider implements Instrument {
  // The registers below are mutated in place and published by reference on every incoming raw
  // event: allocating a fresh Arinc429Word per event causes GC pauses in Coherent. Consumers
  // must not rely on payload object identity (use Arinc429ConsumerSubject or the
  // .withArinc429Precision()/.whenArinc429Changed() filters, which compare by value).
  /** All-zero word for the no-source-valid fallbacks. Never mutated. */
  private static readonly ZERO_WORD = Arinc429Register.empty();

  private readonly betaTarget = Arinc429Register.empty();
  private readonly ecu1MaintenanceWord6 = Arinc429Register.empty();
  private readonly ecu2MaintenanceWord6 = Arinc429Register.empty();
  private readonly estimatedBeta = Arinc429Register.empty();
  private readonly fcdcCaptPitchCommand = Arinc429Register.empty();
  private readonly fcdcCaptRollCommand = Arinc429Register.empty();
  private readonly fcdcFoPitchCommand = Arinc429Register.empty();
  private readonly fcdcFoRollCommand = Arinc429Register.empty();
  private readonly irMaintWord = Arinc429Register.empty();
  private readonly trueHeading = Arinc429Register.empty();
  private readonly trueTrack = Arinc429Register.empty();
  private readonly v3 = Arinc429Register.empty();
  private readonly v4 = Arinc429Register.empty();
  private readonly vAlphaProt = Arinc429Register.empty();
  private readonly vFeNext = Arinc429Register.empty();
  private readonly vLs = Arinc429Register.empty();
  private readonly vMan = Arinc429Register.empty();
  private readonly vMax = Arinc429Register.empty();
  private readonly vStallWarn = Arinc429Register.empty();

  private readonly sub = this.bus.getSubscriber<ClockEvents & FcuBus & PFDSimvars>();

  private readonly roll = Arinc429Register.empty();

  private pitch = Arinc429Register.empty();

  private readonly magTrack = Arinc429Register.empty();

  private readonly heading = Arinc429Register.empty();

  private readonly speed = Arinc429Register.empty();

  /** Displayed altitude. */
  private readonly altitude = Arinc429RegisterSubject.createEmpty();

  private readonly unfilteredAltitude = Arinc429RegisterSubject.createEmpty();

  private readonly baroCorrectedAltitude = Arinc429LocalVarConsumerSubject.create(this.sub.on('baroCorrectedAltitude'));

  private readonly pressureAltitude = Arinc429LocalVarConsumerSubject.create(this.sub.on('pressureAltitude'));

  private readonly altitudeFilter = new LagFilter(1 / 0.3);
  private lastAltitudeFilterTime = -1;

  private readonly fcuDiscrete2 = Arinc429ConsumerSubject.create(this.sub.on('fcuEisDiscreteWord2'));

  private readonly mach = Arinc429Register.empty();

  private readonly vsInert = Arinc429Register.empty();

  private readonly vsBaro = Arinc429Register.empty();

  private readonly groundSpeed = Arinc429Register.empty();

  private readonly ownRadioAltitude = Arinc429Register.empty();

  private readonly oppRadioAltitude = Arinc429Register.empty();

  private readonly fpa = Arinc429Register.empty();

  private readonly da = Arinc429Register.empty();

  private readonly ownLandingElevation = Arinc429Register.empty();

  private readonly oppLandingElevation = Arinc429Register.empty();

  private readonly latAcc = Arinc429Register.empty();

  private readonly fcdc1DiscreteWord1 = Arinc429Register.empty();

  private readonly fcdc2DiscreteWord1 = Arinc429Register.empty();

  private readonly fcdc1DiscreteWord2 = Arinc429Register.empty();

  private readonly fcdc2DiscreteWord2 = Arinc429Register.empty();

  private fcdcToUse = 0;

  private fac1Healthy = false;

  private fac2Healthy = false;

  private readonly fac1VAlphaMax = Arinc429Register.empty();

  private readonly fac2VAlphaMax = Arinc429Register.empty();

  private facToUse = 0;

  private readonly fm1Healthy = ConsumerSubject.create(null, 0);

  private readonly fm2Healthy = ConsumerSubject.create(null, 0);

  private readonly fm1Subs: Subscription[] = [];

  private readonly fm2Subs: Subscription[] = [];

  // each alti source should have a pipe, and only one pipe should be unpaused at a time
  private readonly baroAltitudePipe = this.baroCorrectedAltitude.pipe(this.unfilteredAltitude, true);
  private readonly pressureAltitudePipe = this.pressureAltitude.pipe(this.unfilteredAltitude, true);

  constructor(private readonly bus: ArincEventBus) {}

  /** @inheritdoc */
  public init() {
    const publisher = this.bus.getPublisher<Arinc429Values>();
    const subscriber = this.bus.getSubscriber<FcuBus & PFDSimvars>();

    subscriber.on('pitch').handle((p) => {
      this.pitch.set(p);
      publisher.pub('pitchAr', this.pitch);
    });
    subscriber.on('roll').handle((p) => {
      this.roll.set(p);
      publisher.pub('rollAr', this.roll);
    });
    subscriber.on('magTrackRaw').handle((gt) => {
      this.magTrack.set(gt);
      publisher.pub('magTrack', this.magTrack);
    });
    subscriber.on('magHeadingRaw').handle((h) => {
      this.heading.set(h);
      publisher.pub('magHeading', this.heading);
    });

    subscriber.on('speed').handle((s) => {
      this.speed.set(s);
      publisher.pub('speedAr', this.speed);
    });

    this.altitude.sub((v) => publisher.pub('altitudeAr', v));

    this.fcuDiscrete2.sub((v) => {
      // default to STD if FCU invalid
      const isStd = v.bitValue(28) || v.isFailureWarning();
      if (isStd) {
        this.baroAltitudePipe.pause();
        this.pressureAltitudePipe.resume(true);
      } else {
        this.pressureAltitudePipe.pause();
        this.baroAltitudePipe.resume(true);
      }
    }, true);

    subscriber.on('mach').handle((m) => {
      this.mach.set(m);
      publisher.pub('machAr', this.mach);
    });

    subscriber.on('vsInert').handle((ivs) => {
      this.vsInert.set(ivs);

      if (this.vsInert.isNormalOperation()) {
        publisher.pub('vs', this.vsInert);
      }
    });

    subscriber.on('vsBaro').handle((vsb) => {
      this.vsBaro.set(vsb);
      if (!this.vsInert.isNormalOperation()) {
        publisher.pub('vs', this.vsBaro);
      }
    });

    subscriber.on('groundSpeed').handle((gs) => {
      this.groundSpeed.set(gs);
      publisher.pub('gs', this.groundSpeed);
    });

    subscriber.on('radioAltitude1').handle((ra) => {
      if (getDisplayIndex() === 1) {
        this.ownRadioAltitude.set(ra);
      } else {
        this.oppRadioAltitude.set(ra);
      }
      this.determineAndPublishChosenRadioAltitude(publisher);
    });

    subscriber.on('radioAltitude2').handle((ra) => {
      if (getDisplayIndex() === 2) {
        this.ownRadioAltitude.set(ra);
      } else {
        this.oppRadioAltitude.set(ra);
      }
      this.determineAndPublishChosenRadioAltitude(publisher);
    });

    subscriber.on('fpaRaw').handle((fpa) => {
      this.fpa.set(fpa);
      publisher.pub('fpa', this.fpa);
    });

    subscriber.on('daRaw').handle((da) => {
      this.da.set(da);
      publisher.pub('da', this.da);
    });

    subscriber.on('landingElevation1Raw').handle((elevation) => {
      if (getDisplayIndex() === 1) {
        this.ownLandingElevation.set(elevation);
      } else {
        this.oppLandingElevation.set(elevation);
      }
      this.determineAndPublishChosenLandingElevation(publisher);
    });

    subscriber.on('landingElevation2Raw').handle((elevation) => {
      if (getDisplayIndex() === 1) {
        this.ownLandingElevation.set(elevation);
      } else {
        this.oppLandingElevation.set(elevation);
      }
      this.determineAndPublishChosenLandingElevation(publisher);
    });

    subscriber.on('latAccRaw').handle((latAcc) => {
      this.latAcc.set(latAcc);
      publisher.pub('latAcc', this.latAcc);
    });

    subscriber.on('fcdc1DiscreteWord1Raw').handle((discreteWord1) => {
      this.fcdc1DiscreteWord1.set(discreteWord1);
      this.fcdcToUse = this.determineFcdcToUse();
      publisher.pub('fcdc1DiscreteWord1', this.fcdc1DiscreteWord1);
      if (this.fcdcToUse === 1) {
        publisher.pub('fcdcDiscreteWord1', this.fcdc1DiscreteWord1);
      }
    });

    subscriber.on('fcdc2DiscreteWord1Raw').handle((discreteWord1) => {
      this.fcdc2DiscreteWord1.set(discreteWord1);
      this.fcdcToUse = this.determineFcdcToUse();
      publisher.pub('fcdc2DiscreteWord1', this.fcdc2DiscreteWord1);
      if (this.fcdcToUse === 2) {
        publisher.pub('fcdcDiscreteWord1', this.fcdc2DiscreteWord1);
      }
    });

    subscriber.on('fcdc1DiscreteWord2Raw').handle((discreteWord2) => {
      this.fcdc1DiscreteWord2.set(discreteWord2);
      publisher.pub('fcdc1DiscreteWord2', this.fcdc1DiscreteWord2);
    });

    subscriber.on('fcdc2DiscreteWord2Raw').handle((discreteWord2) => {
      this.fcdc2DiscreteWord2.set(discreteWord2);
      publisher.pub('fcdc2DiscreteWord2', this.fcdc2DiscreteWord2);
    });

    subscriber.on('fcdc1CaptPitchCommandRaw').handle((word) => {
      if (this.fcdcToUse === 1) {
        publisher.pub('fcdcCaptPitchCommand', this.fcdcCaptPitchCommand.set(word));
      }
    });

    subscriber.on('fcdc2CaptPitchCommandRaw').handle((word) => {
      if (this.fcdcToUse === 2) {
        publisher.pub('fcdcCaptPitchCommand', this.fcdcCaptPitchCommand.set(word));
      }
    });

    subscriber.on('fcdc1FoPitchCommandRaw').handle((word) => {
      if (this.fcdcToUse === 1) {
        publisher.pub('fcdcFoPitchCommand', this.fcdcFoPitchCommand.set(word));
      }
    });

    subscriber.on('fcdc2FoPitchCommandRaw').handle((word) => {
      if (this.fcdcToUse === 2) {
        publisher.pub('fcdcFoPitchCommand', this.fcdcFoPitchCommand.set(word));
      }
    });

    subscriber.on('fcdc1CaptRollCommandRaw').handle((word) => {
      if (this.fcdcToUse === 1) {
        publisher.pub('fcdcCaptRollCommand', this.fcdcCaptRollCommand.set(word));
      }
    });

    subscriber.on('fcdc2CaptRollCommandRaw').handle((word) => {
      if (this.fcdcToUse === 2) {
        publisher.pub('fcdcCaptRollCommand', this.fcdcCaptRollCommand.set(word));
      }
    });

    subscriber.on('fcdc1FoRollCommandRaw').handle((word) => {
      if (this.fcdcToUse === 1) {
        publisher.pub('fcdcFoRollCommand', this.fcdcFoRollCommand.set(word));
      }
    });

    subscriber.on('fcdc2FoRollCommandRaw').handle((word) => {
      if (this.fcdcToUse === 2) {
        publisher.pub('fcdcFoRollCommand', this.fcdcFoRollCommand.set(word));
      }
    });

    subscriber.on('fac1Healthy').handle((val) => {
      this.fac1Healthy = val;
      this.determineFacToUse(publisher);
    });

    subscriber.on('fac2Healthy').handle((val) => {
      this.fac2Healthy = val;
      this.determineFacToUse(publisher);
    });

    subscriber.on('fac1VAlphaMaxRaw').handle((word) => {
      this.fac1VAlphaMax.set(word);
      this.determineFacToUse(publisher);
      if (this.facToUse === 1) {
        publisher.pub('vAlphaMax', this.fac1VAlphaMax);
      } else if (this.facToUse === 0) {
        publisher.pub('vAlphaMax', ArincValueProvider.ZERO_WORD);
      }
    });

    subscriber.on('fac2VAlphaMaxRaw').handle((word) => {
      this.fac2VAlphaMax.set(word);
      this.determineFacToUse(publisher);
      if (this.facToUse === 2) {
        publisher.pub('vAlphaMax', this.fac2VAlphaMax);
      }
    });

    subscriber.on('fac1VAlphaProtRaw').handle((word) => {
      if (this.facToUse === 1) {
        publisher.pub('vAlphaProt', this.vAlphaProt.set(word));
      } else if (this.facToUse === 0) {
        publisher.pub('vAlphaProt', ArincValueProvider.ZERO_WORD);
      }
    });

    subscriber.on('fac2VAlphaProtRaw').handle((word) => {
      if (this.facToUse === 2) {
        publisher.pub('vAlphaProt', this.vAlphaProt.set(word));
      }
    });

    subscriber.on('fac1VStallWarnRaw').handle((word) => {
      if (this.facToUse === 1) {
        publisher.pub('vStallWarn', this.vStallWarn.set(word));
      } else if (this.facToUse === 0) {
        publisher.pub('vStallWarn', ArincValueProvider.ZERO_WORD);
      }
    });

    subscriber.on('fac2VStallWarnRaw').handle((word) => {
      if (this.facToUse === 2) {
        publisher.pub('vStallWarn', this.vStallWarn.set(word));
      }
    });

    subscriber.on('fac1VMaxRaw').handle((word) => {
      if (this.facToUse === 1) {
        publisher.pub('vMax', this.vMax.set(word));
      } else if (this.facToUse === 0) {
        publisher.pub('vMax', ArincValueProvider.ZERO_WORD);
      }
    });

    subscriber.on('fac2VMaxRaw').handle((word) => {
      if (this.facToUse === 2) {
        publisher.pub('vMax', this.vMax.set(word));
      }
    });

    subscriber.on('fac1VFeNextRaw').handle((word) => {
      if (this.facToUse === 1) {
        publisher.pub('vFeNext', this.vFeNext.set(word));
      } else if (this.facToUse === 0) {
        publisher.pub('vFeNext', ArincValueProvider.ZERO_WORD);
      }
    });

    subscriber.on('fac2VFeNextRaw').handle((word) => {
      if (this.facToUse === 2) {
        publisher.pub('vFeNext', this.vFeNext.set(word));
      }
    });

    subscriber.on('fac1VCTrendRaw').handle((word) => {
      if (this.facToUse === 1) {
        publisher.pub('vCTrend', word);
      } else if (this.facToUse === 0) {
        publisher.pub('vCTrend', 0);
      }
    });

    subscriber.on('fac2VCTrendRaw').handle((word) => {
      if (this.facToUse === 2) {
        publisher.pub('vCTrend', word);
      }
    });

    subscriber.on('fac1VManRaw').handle((word) => {
      if (this.facToUse === 1) {
        publisher.pub('vMan', this.vMan.set(word));
      } else if (this.facToUse === 0) {
        publisher.pub('vMan', ArincValueProvider.ZERO_WORD);
      }
    });

    subscriber.on('fac2VManRaw').handle((word) => {
      if (this.facToUse === 2) {
        publisher.pub('vMan', this.vMan.set(word));
      }
    });

    subscriber.on('fac1V4Raw').handle((word) => {
      if (this.facToUse === 1) {
        publisher.pub('v4', this.v4.set(word));
      } else if (this.facToUse === 0) {
        publisher.pub('v4', ArincValueProvider.ZERO_WORD);
      }
    });

    subscriber.on('fac2V4Raw').handle((word) => {
      if (this.facToUse === 2) {
        publisher.pub('v4', this.v4.set(word));
      }
    });

    subscriber.on('fac1V3Raw').handle((word) => {
      if (this.facToUse === 1) {
        publisher.pub('v3', this.v3.set(word));
      } else if (this.facToUse === 0) {
        publisher.pub('v3', ArincValueProvider.ZERO_WORD);
      }
    });

    subscriber.on('fac2V3Raw').handle((word) => {
      if (this.facToUse === 2) {
        publisher.pub('v3', this.v3.set(word));
      }
    });

    subscriber.on('fac1VLsRaw').handle((word) => {
      if (this.facToUse === 1) {
        publisher.pub('vLs', this.vLs.set(word));
      } else if (this.facToUse === 0) {
        publisher.pub('vLs', ArincValueProvider.ZERO_WORD);
      }
    });

    subscriber.on('fac2VLsRaw').handle((word) => {
      if (this.facToUse === 2) {
        publisher.pub('vLs', this.vLs.set(word));
      }
    });

    subscriber.on('fac1EstimatedBetaRaw').handle((word) => {
      if (this.facToUse === 1) {
        publisher.pub('estimatedBeta', this.estimatedBeta.set(word));
      } else if (this.facToUse === 0) {
        publisher.pub('estimatedBeta', ArincValueProvider.ZERO_WORD);
      }
    });

    subscriber.on('fac2EstimatedBetaRaw').handle((word) => {
      if (this.facToUse === 2) {
        publisher.pub('estimatedBeta', this.estimatedBeta.set(word));
      }
    });

    subscriber.on('fac1BetaTargetRaw').handle((word) => {
      if (this.facToUse === 1) {
        publisher.pub('betaTarget', this.betaTarget.set(word));
      } else if (this.facToUse === 0) {
        publisher.pub('betaTarget', ArincValueProvider.ZERO_WORD);
      }
    });

    subscriber.on('fac2BetaTargetRaw').handle((word) => {
      if (this.facToUse === 2) {
        publisher.pub('betaTarget', this.betaTarget.set(word));
      }
    });

    subscriber.on('irMaintWordRaw').handle((word) => {
      publisher.pub('irMaintWord', this.irMaintWord.set(word));
    });

    subscriber.on('trueHeadingRaw').handle((word) => {
      publisher.pub('trueHeading', this.trueHeading.set(word));
    });

    subscriber.on('trueTrackRaw').handle((word) => {
      publisher.pub('trueTrack', this.trueTrack.set(word));
    });

    this.fm1Subs.push(
      subscriber.on('fm1EisDiscrete2Raw').handle((raw) => publisher.pub('fmEisDiscreteWord2Raw', raw), true),
    );
    this.fm2Subs.push(
      subscriber.on('fm2EisDiscrete2Raw').handle((raw) => publisher.pub('fmEisDiscreteWord2Raw', raw), true),
    );
    this.fm1Subs.push(subscriber.on('fm1MdaRaw').handle((raw) => publisher.pub('fmMdaRaw', raw), true));
    this.fm2Subs.push(subscriber.on('fm2MdaRaw').handle((raw) => publisher.pub('fmMdaRaw', raw), true));
    this.fm1Subs.push(subscriber.on('fm1DhRaw').handle((raw) => publisher.pub('fmDhRaw', raw), true));
    this.fm2Subs.push(subscriber.on('fm2DhRaw').handle((raw) => publisher.pub('fmDhRaw', raw), true));
    this.fm1Subs.push(subscriber.on('fm1TransAltRaw').handle((raw) => publisher.pub('fmTransAltRaw', raw), true));
    this.fm2Subs.push(subscriber.on('fm2TransAltRaw').handle((raw) => publisher.pub('fmTransAltRaw', raw), true));
    this.fm1Subs.push(subscriber.on('fm1TransLvlRaw').handle((raw) => publisher.pub('fmTransLvlRaw', raw), true));
    this.fm2Subs.push(subscriber.on('fm2TransLvlRaw').handle((raw) => publisher.pub('fmTransLvlRaw', raw), true));

    this.fm1Healthy.setConsumer(subscriber.on('fm1HealthyDiscrete'));
    this.fm2Healthy.setConsumer(subscriber.on('fm2HealthyDiscrete'));
    this.fm1Healthy.sub(this.determineFmToUse.bind(this));
    this.fm2Healthy.sub(this.determineFmToUse.bind(this), true);

    subscriber.on('ecu1MaintenanceWord6Raw').handle((word) => {
      publisher.pub('ecu1MaintenanceWord6', this.ecu1MaintenanceWord6.set(word));
    });

    subscriber.on('ecu2MaintenanceWord6Raw').handle((word) => {
      publisher.pub('ecu2MaintenanceWord6', this.ecu2MaintenanceWord6.set(word));
    });

    // Do the filter at hi freq for accuracy, but we don't want to publish the ARINC word at hi-freq
    // as hi-frequency SVG redraws would be very bad.
    this.sub.on('simTimeHiFreq').handle((time) => {
      const deltaTime = MathUtils.clamp(time - this.lastAltitudeFilterTime, 0, 300);
      this.lastAltitudeFilterTime = time;

      this.altitudeFilter.step(this.unfilteredAltitude.get().value, deltaTime / 1000);
    });
  }

  /** @inheritdoc */
  public onUpdate(): void {
    this.altitude.setValueSsm(this.altitudeFilter.previousOutput(), this.unfilteredAltitude.get().ssm);
  }

  private determineAndPublishChosenRadioAltitude(publisher: Publisher<Arinc429Values>) {
    const ownRadioAltitudeHasData =
      !this.ownRadioAltitude.isFailureWarning() && !this.ownRadioAltitude.isNoComputedData();
    const oppRadioAltitudeHasData =
      !this.oppRadioAltitude.isFailureWarning() && !this.oppRadioAltitude.isNoComputedData();
    const chosenRadioAltitude =
      // the own RA has no data and the opposite one has data
      (!ownRadioAltitudeHasData && oppRadioAltitudeHasData) ||
      // the own RA has FW and the opposite has NCD
      (this.ownRadioAltitude.isFailureWarning() && this.oppRadioAltitude.isNoComputedData())
        ? this.oppRadioAltitude
        : this.ownRadioAltitude;

    publisher.pub('chosenRa', chosenRadioAltitude);
  }

  private determineAndPublishChosenLandingElevation(publisher: Publisher<Arinc429Values>) {
    const useOpposite =
      (this.ownLandingElevation.isFailureWarning() || this.ownLandingElevation.isNoComputedData()) &&
      !this.oppLandingElevation.isFailureWarning() &&
      !this.oppLandingElevation.isNoComputedData();

    if (useOpposite) {
      publisher.pub('landingElevation', this.oppLandingElevation);
    } else {
      publisher.pub('landingElevation', this.ownLandingElevation);
    }
  }

  private determineFcdcToUse() {
    if (getDisplayIndex() === 1) {
      if (
        (this.fcdc1DiscreteWord1.isFailureWarning() && !this.fcdc2DiscreteWord1.isFailureWarning()) ||
        (!this.fcdc1DiscreteWord1.bitValueOr(24, false) && this.fcdc2DiscreteWord1.bitValueOr(24, false))
      ) {
        return 2;
      }
      return 1;
    }
    if (
      !(
        (!this.fcdc1DiscreteWord1.isFailureWarning() && this.fcdc2DiscreteWord1.isFailureWarning()) ||
        (this.fcdc1DiscreteWord1.bitValueOr(24, false) && !this.fcdc2DiscreteWord1.bitValueOr(24, false))
      )
    ) {
      return 2;
    }
    return 1;
  }

  // Determine which FAC bus to use for FE function. If FAC HEALTHY discrete is low or any word is coded FW,
  // declare FAC as invalid. For simplicty reasons, only check SSM of words that use the same data, so all failure cases are
  // handled while minimizing the words that have to be checked.
  // Left PFD uses FAC 1 when both are valid, the right PFD uses FAC 2. In case of invalidity, switchover is performed.
  // If no FAC is valid, set facToUse to 0. This causes the SPD LIM flag to be displayed.
  private determineFacToUse(publisher: Publisher<Arinc429Values>) {
    const fac1Valid = this.fac1Healthy && !this.fac1VAlphaMax.isFailureWarning();
    const fac2Valid = this.fac2Healthy && !this.fac2VAlphaMax.isFailureWarning();
    if (getDisplayIndex() === 1 && fac1Valid) {
      this.facToUse = 1;
    } else if (getDisplayIndex() === 2 && fac2Valid) {
      this.facToUse = 2;
    } else if (fac1Valid) {
      this.facToUse = 1;
    } else if (fac2Valid) {
      this.facToUse = 2;
    } else {
      this.facToUse = 0;
    }

    publisher.pub('facToUse', this.facToUse);
  }

  private determineFmToUse(): void {
    const onSideIndex = MathUtils.clamp(getDisplayIndex(), 1, 2);

    const onlyFm1Healthy = this.fm1Healthy.get() && !this.fm2Healthy.get();
    const onlyFm2Healthy = this.fm2Healthy.get() && !this.fm1Healthy.get();

    if ((onSideIndex === 1 && !onlyFm2Healthy) || onlyFm1Healthy) {
      this.fm2Subs.forEach((sub) => sub.pause());
      this.fm1Subs.forEach((sub) => sub.resume(true));
    } else if ((onSideIndex === 2 && !onlyFm1Healthy) || onlyFm2Healthy) {
      this.fm1Subs.forEach((sub) => sub.pause());
      this.fm2Subs.forEach((sub) => sub.resume(true));
    }
  }
}

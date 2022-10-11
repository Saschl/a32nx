/* eslint-disable jsdoc/require-jsdoc */
import { EventBus } from '../../data/EventBus';
import { NumberUnitInterface, UnitFamily, UnitType } from '../../math';
import { ReadonlyFloat64Array, Vec2Math } from '../../math/VecMath';
import { VecNSubject } from '../../math/VectorSubject';
import { Subject } from '../../sub/Subject';
import { Subscribable } from '../../sub/Subscribable';
import { MutableSubscribableSet, SubscribableSet } from '../../sub/SubscribableSet';
import { ResourceModerator } from '../../utils/resource';
import { FSComponent, VNode } from '../FSComponent';
import { MapBingLayer } from '../map/layers/MapBingLayer';
import { MapCullableTextLayer } from '../map/layers/MapCullableTextLayer';
import { MapOwnAirplaneLayer, MapOwnAirplaneLayerModules } from '../map/layers/MapOwnAirplaneLayer';
import { MapCullableTextLabelManager } from '../map/MapCullableTextLabel';
import { MapLayer } from '../map/MapLayer';
import { MapProjection } from '../map/MapProjection';
import { MapOwnAirplaneIconModule } from '../map/modules/MapOwnAirplaneIconModule';
import { MapOwnAirplanePropsModule } from '../map/modules/MapOwnAirplanePropsModule';
import { MapBinding, MapBindingsController, MapTransformedBinding } from './controllers/MapBindingsController';
import { MapClockUpdateController, MapClockUpdateControllerContext } from './controllers/MapClockUpdateController';
import { MapFollowAirplaneController, MapFollowAirplaneControllerContext, MapFollowAirplaneControllerModules } from './controllers/MapFollowAirplaneController';
import { MapRotationController, MapRotationControllerContext, MapRotationControllerModules } from './controllers/MapRotationController';
import { MapSystemComponent, MapSystemComponentProps } from './MapSystemComponent';
import { DefaultMapSystemContext, MapSystemContext, MutableMapContext } from './MapSystemContext';
import { MapSystemController } from './MapSystemController';
import { MapSystemKeys } from './MapSystemKeys';
import {
  CompiledMapSystem, ContextRecord, ControllerRecord, EmptyRecord, LayerRecord, ModuleRecord, RequiredControllerContext, RequiredControllerLayers,
  RequiredControllerModules, RequiredLayerModules
} from './MapSystemTypes';
import { MapSystemUtils } from './MapSystemUtils';
import { MapFollowAirplaneModule } from './modules/MapFollowAirplaneModule';
import { MapRotationModule } from './modules/MapRotationModule';
import { MapTerrainColorsModule } from './modules/MapTerrainColorsModule';
import { MapWxrModule } from './modules/MapWxrModule';

/**
 * A function which defines a custom build step.
 */
export type MapSystemCustomBuilder<
  Args extends any[] = any[],
  RequiredModules extends ModuleRecord = any,
  RequiredLayers extends LayerRecord = any,
  RequiredContext extends ContextRecord = any
  > = (mapBuilder: MapSystemBuilder<RequiredModules, RequiredLayers, any, RequiredContext>, ...args: Args) => MapSystemBuilder<any, any, any, any>;

/**
 * Retrieves the extra arguments, after the map builder, of a custom builder.
 */
type CustomBuilderArgs<Builder> = Builder extends MapSystemCustomBuilder<infer Args> ? Args : never;

/**
 * Retrieves a custom map builder's required modules.
 */
export type RequiredCustomBuilderModules<Builder> = Builder extends MapSystemCustomBuilder<any, infer M> ? M : never;

/**
 * Retrieves a custom map builder's required layers.
 */
export type RequiredCustomBuilderLayers<Builder> = Builder extends MapSystemCustomBuilder<any, any, infer L> ? L : never;

/**
 * Retrieves a custom map builder's required context.
 */
export type RequiredCustomBuilderContext<Builder> = Builder extends MapSystemCustomBuilder<any, any, any, infer Context> ? Context : never;

/**
 * A map model module factory.
 */
type ModuleFactory = {
  /** The key of the module to create. */
  key: string;

  /** The constructor of the module to create. */
  factory: () => any;
};

/**
 * A map layer factory.
 */
type LayerFactory = {
  /** The key of the layer to create. */
  key: string;

  /** A function which renders the layer to create. */
  factory: (context: MapSystemContext<any, any, any, any>) => VNode;

  /** The order value of the layer to create. */
  order: number;
};

/**
 * A map controller factory.
 */
type ControllerFactory = {
  /** A function which creates the controller. */
  factory: (context: MapSystemContext<any, any, any, any>) => MapSystemController<any, any, any>;
};

/**
 * A map context property factory.
 */
type ContextFactory = {
  /** The key of the property to create. */
  key: string;

  /** A function which creates the context property. */
  factory: (context: MapSystemContext<any, any, any, any>) => any;

  /** The value determining in which order to create the property.  */
  order: number;
};

/**
 * Checks if a set of module, layer, and context records meet certain requirements. If the requirements are met, the
 * specified type is returned. If the requirements are not met, `never` is returned.
 */
type ConditionalReturn<
  Modules,
  RequiredModules,
  Layers,
  RequiredLayers,
  Context,
  RequiredContext,
  ReturnType
  > = Modules extends RequiredModules ? Layers extends RequiredLayers ? Context extends RequiredContext ? ReturnType : never : never : never;

/** Checks if a type is exactly the `any` type. */
type IsAny<T> = boolean extends (T extends never ? true : false) ? true : false;

/** Returns a type if it is not `any`, otherwise returns a default type. */
type DefaultIfAny<T, Default> = IsAny<T> extends true ? Default : T;

/**
 * Builds maps. Each builder is configured with a series of build steps which collectively define how the builder
 * compiles finished maps. In addition to defining basic map properties such as size and range, build steps can also
 * customize map behavior and appearance through adding map model modules, layers, and controllers.
 *
 * Each map compiled by the builder is associated with a {@link MapSystemContext}, which holds references to the map
 * projection, map model, all layers and controllers, and other data associated with the map. Layers and controllers
 * have access to the context when they are created during compilation, and a reference to the context is stored with
 * the compiled map.
 *
 * A single builder can compile multiple maps. Each compiled map is a separate entity, with its own model, layers,
 * controllers, and context.
 */
export class MapSystemBuilder<
  Modules extends ModuleRecord = any,
  Layers extends LayerRecord = any,
  Controllers extends ControllerRecord = any,
  Context extends ContextRecord = any,
  > {

  protected static readonly RESTRICTED_CONTEXT_KEYS = new Set([
    'bus',
    'model',
    'projection',
    'projectedSize',
    'deadZone',
    'getLayer',
    'setLayer',
    'getController',
    'setController'
  ]);

  protected readonly moduleFactories = new Map<string, ModuleFactory>();
  protected readonly layerFactories = new Map<string, LayerFactory>();
  protected readonly controllerFactories = new Map<string, ControllerFactory>();
  protected readonly contextFactories = new Map<string, ContextFactory>();
  protected readonly initCallbacks = new Map<string, (context: MapSystemContext<any, any, any, any>) => void>();

  protected projectedSize: Subscribable<ReadonlyFloat64Array> = Subject.create(Vec2Math.create(100, 100));
  protected deadZone?: Subscribable<ReadonlyFloat64Array>;
  protected targetOffset?: ReadonlyFloat64Array;
  protected nominalRangeEndpoints?: ReadonlyFloat64Array;
  protected range?: number;

  // eslint-disable-next-line jsdoc/require-returns
  /** The number of map model modules added to this builder. */
  public get moduleCount(): number {
    return this.moduleFactories.size;
  }

  // eslint-disable-next-line jsdoc/require-returns
  /** The number of map layers added to this builder. */
  public get layerCount(): number {
    return this.layerFactories.size;
  }

  // eslint-disable-next-line jsdoc/require-returns
  /** The number of map controllers added to this builder. */
  public get controllerCount(): number {
    return this.controllerFactories.size;
  }

  /**
   * Creates an instance of a map system builder.
   * @param bus This builder's event bus.
   */
  protected constructor(public readonly bus: EventBus) {
  }

  /**
   * Creates a new Garmin map builder. The builder is initialized with a default projected size of `[100, 100]` pixels.
   * @param bus The event bus.
   * @returns A new Garmin map builder.
   */
  public static create(bus: EventBus): MapSystemBuilder {
    return new MapSystemBuilder(bus);
  }

  /**
   * Configures this builder to generate a map with a given projected window size.
   * @param size The size of the projected window, as `[width, height]` in pixels, or a subscribable which provides it.
   * @returns This builder, after it has been configured.
   */
  public withProjectedSize(size: ReadonlyFloat64Array | Subscribable<ReadonlyFloat64Array>): this {
    this.projectedSize = 'isSubscribable' in size ? size : Subject.create(size);
    return this;
  }

  /**
   * Configures this builder to generate a map with a given dead zone.
   * @param deadZone The dead zone, as `[left, top, right, bottom]` in pixels, or a subscribable which provides it.
   * @returns This builder, after it has been configured.
   */
  public withDeadZone(deadZone: ReadonlyFloat64Array | Subscribable<ReadonlyFloat64Array>): this {
    this.deadZone = 'isSubscribable' in deadZone ? deadZone : VecNSubject.createFromVector(new Float64Array(deadZone));
    return this;
  }

  /**
   * Configures this builder to generate a map with an initial projected target offset.
   * @param offset The initial projected target offset, as `[x, y]` in pixels.
   * @returns This builder, after it has been configured.
   */
  public withTargetOffset(offset: ReadonlyFloat64Array): this {
    this.targetOffset = offset;
    return this;
  }

  /**
   * Configures this builder to generate a map with specific initial range endpoints. The endpoints are defined
   * relative to the width and height of the map's projected window, *excluding* the dead zone.
   * @param endpoints The initial range endpoints, as `[x1, y1, x2, y2]`.
   * @returns This builder, after it has been configured.
   */
  public withRangeEndpoints(endpoints: ReadonlyFloat64Array): this {
    this.nominalRangeEndpoints = endpoints;
    return this;
  }

  /**
   * Configures this build to generate a map with a specific initial range.
   * @param range The initial range.
   * @returns This builder, after it has been configured.
   */
  public withRange(range: NumberUnitInterface<UnitFamily.Distance>): this {
    this.range = range.asUnit(UnitType.GA_RADIAN);
    return this;
  }

  /**
   * Adds a map module to this builder. When this builder compiles its map, all added modules will be created and added
   * to the map's model. If an existing module has been added to this builder with the same key, it will be replaced.
   * @param key The key (name) of the module.
   * @param factory A function which creates the module.
   * @returns This builder, after the map module has been added.
   */
  public withModule(key: string, factory: () => any): this {
    this.moduleFactories.set(key, { key, factory });
    return this;
  }

  /**
   * Adds a map layer to this builder. When this builder compiles its map, all added layers will be created and
   * attached to the map. Layers with a lower assigned order will be attached before and appear below layers with
   * greater assigned order values. If an existing layer has been added to this builder with the same key, it will be
   * replaced.
   * @param key The key of the layer.
   * @param factory A function which renders the layer as a VNode.
   * @param order The order assigned to the layer. Layers with lower assigned order will be attached to the map before
   * and appear below layers with greater assigned order values. Defaults to the number of layers already added to this
   * builder.
   * @returns This builder, after the map layer has been added, or `never` if this builder does not have all the
   * modules required by the layer.
   */
  public withLayer<L extends MapLayer = any, UseModules = any, UseContext = any>(
    key: string,
    factory: (context: MapSystemContext<DefaultIfAny<UseModules, Modules>, EmptyRecord, EmptyRecord, DefaultIfAny<UseContext, Context>>) => VNode,
    order?: number
  ): ConditionalReturn<
    DefaultIfAny<UseModules, Modules>,
    RequiredLayerModules<L>,
    any, any,
    any, any,
    this
  > {
    // Delete the key to ensure a consistent layer order.
    const wasDeleted = this.layerFactories.delete(key);

    this.layerFactories.set(key, { key, factory, order: order ?? (this.layerFactories.size + (wasDeleted ? 1 : 0)) });
    return this as any;
  }

  /**
   * Adds a controller to this builder. When this builder compiles its map, all added controllers will be created and
   * hooked up to the map's lifecycle callbacks. If an existing controller has been added to this builder with the same
   * key, it will be replaced.
   * @param key The key of the controller.
   * @param factory A function which creates the controller.
   * @returns This builder, after the map layer has been added, or `never` if this builder does not have all the
   * modules required by the controller.
   */
  public withController<
    Controller extends MapSystemController<any, any, any, any>,
    UseModules = any,
    UseLayers extends LayerRecord = any,
    UseControllers extends ControllerRecord = any,
    UseContext = any
  >(
    key: string,
    factory: (
      context: MapSystemContext<
        DefaultIfAny<UseModules, Modules>,
        DefaultIfAny<UseLayers, Layers>,
        DefaultIfAny<UseControllers, Controllers>,
        DefaultIfAny<UseContext, Context>
      >
    ) => Controller
  ): ConditionalReturn<
    DefaultIfAny<UseModules, Modules>,
    RequiredControllerModules<Controller>,
    DefaultIfAny<UseLayers, Layers>,
    RequiredControllerLayers<Controller>,
    DefaultIfAny<UseContext, Context>,
    RequiredControllerContext<Controller>,
    this
  > {
    this.controllerFactories.set(key, { factory });
    return this as any;
  }

  /**
   * Adds a context property to this builder. When the builder compiles its map, all added properties will be available
   * on the context. Properties are created on the context in the order they were added to the builder, and property
   * factories have access to previously created properties on the context. If an existing property has been added to
   * this builder with the same key, it will be replaced.
   * @param key The key of the property to add.
   * @param factory A function which creates the value of the property.
   * @returns This builder, after the context property has been added.
   */
  public withContext<UseContext = any>(
    key: Exclude<string, keyof MapSystemContext>,
    factory: (context: MapSystemContext<Record<never, never>, Record<never, never>, Record<never, never>, DefaultIfAny<UseContext, Context>>) => any
  ): this {
    if (!MapSystemBuilder.RESTRICTED_CONTEXT_KEYS.has(key)) {
      const existing = this.contextFactories.get(key as any);
      const order = existing?.order ?? this.contextFactories.size;

      this.contextFactories.set(key as any, { key, factory, order });
    }
    return this as any;
  }

  /**
   * Configures this builder to execute a callback function immediately after it is finished compiling a map. If an
   * existing callback has been added to this builder with the same key, it will be replaced.
   * @param key The key of the callback.
   * @param callback The callback function to add.
   * @returns This builder, after the callback has been added.
   */
  public withInit<
    UseModules = any,
    UseLayers extends LayerRecord = any,
    UseControllers extends ControllerRecord = any,
    UseContext = any
  >(
    key: string,
    callback: (
      context: MapSystemContext<
        DefaultIfAny<UseModules, Modules>,
        DefaultIfAny<UseLayers, Layers>,
        DefaultIfAny<UseControllers, Controllers>,
        DefaultIfAny<UseContext, Context>
      >
    ) => void
  ): this {
    this.initCallbacks.set(key, callback);
    return this;
  }

  /**
   * Assigns an order value to a layer. Layers with a lower assigned order will be attached before and appear below
   * layers with greater assigned order values.
   * @param key The key of the layer to which to assign the order value.
   * @param order The order value to assign.
   * @returns This builder, after the order value has been assigned.
   */
  public withLayerOrder(key: keyof Layers & string, order: number): this {
    const factory = this.layerFactories.get(key);
    if (factory) {
      // Delete the key to ensure a consistent layer order.
      this.layerFactories.delete(key);
      factory.order = order;
      this.layerFactories.set(key, factory);
    }
    return this;
  }

  /**
   * Configures this builder to add a controller which maintains a list of bindings from source to target
   * subscribables.
   * @param key The key of the controller.
   * @param bindings The bindings to maintain.
   * @returns This builder, after it has been configured.
   */
  public withBindings<
    UseModules = any,
    UseLayers extends LayerRecord = any,
    UseContext = any
  >(
    key: string,
    bindings: (context: MapSystemContext<
      DefaultIfAny<UseModules, Modules>,
      DefaultIfAny<UseLayers, Layers>,
      EmptyRecord,
      DefaultIfAny<UseContext, Context>
    >) => Iterable<MapBinding<any> | MapTransformedBinding<any, any>>
  ): this {
    return this.withController(key, context => new MapBindingsController(context, bindings(context as any)));
  }

  /**
   * Configures this builder to generate a map which is updated at a regular frequency based on event bus clock events.
   *
   * Adds the following...
   *
   * Context properties:
   * * `'updateFreq': Subscribable<number>`
   *
   * Controllers:
   * * `[MapSystemKeys.ClockUpdate]: MapClockUpdateController`.
   * @param updateFreq The map's update frequency, in hertz, or a subscribable which provides it.
   * @returns This builder, after it has been configured.
   */
  public withClockUpdate(updateFreq: number | Subscribable<number>): this {
    return this
      .withContext('updateFreq', () => typeof updateFreq === 'number' ? Subject.create(updateFreq) : updateFreq)
      .withController<
        MapClockUpdateController, any, any, any, MapClockUpdateControllerContext
      >(MapSystemKeys.ClockUpdate, context => new MapClockUpdateController(context));
  }

  /**
   * Configures this builder to add a resource moderator for control of the map's projection target.
   *
   * Adds the context property `[MapSystemKeys.TargetControl]: ResourceModerator<void>`.
   * @returns This builder, after the resource moderator has been added.
   */
  public withTargetControlModerator(): this {
    return this.withContext(MapSystemKeys.TargetControl, () => new ResourceModerator(undefined));
  }

  /**
   * Configures this builder to add a resource moderator for control of the map's rotation.
   *
   * Adds the context property `[MapSystemKeys.RotationControl]: ResourceModerator<void>`.
   * @returns This builder, after the resource moderator has been added.
   */
  public withRotationControlModerator(): this {
    return this.withContext(MapSystemKeys.RotationControl, () => new ResourceModerator(undefined));
  }

  /**
   * Configures this builder to add a resource moderator for control of the map's range.
   *
   * Adds the context property `[MapSystemKeys.RangeControl]: ResourceModerator<void>`.
   * @returns This builder, after the resource moderator has been added.
   */
  public withRangeControlModerator(): this {
    return this.withContext(MapSystemKeys.RangeControl, () => new ResourceModerator(undefined));
  }

  /**
   * Configures this builder to generate a map whose projection target follows the player airplane. The follow airplane
   * behavior will be active if and only if the controller owns the projection target control resource. The
   * controller's priority for the resource is `0`.
   *
   * Adds the following...
   *
   * Context properties:
   * * `[MapSystemKeys.TargetControl]: ResourceModerator<void>`
   *
   * Modules:
   * * `[MapSystemKeys.OwnAirplaneProps]: MapOwnAirplanePropsModule`
   * * `[MapSystemKeys.FollowAirplane]: MapFollowAirplaneModule`
   *
   * Controllers:
   * * `[MapSystemKeys.FollowAirplane]: MapFollowAirplaneController`
   * @returns This builder, after it has been configured.
   */
  public withFollowAirplane(): this {
    return this
      .withModule(MapSystemKeys.OwnAirplaneProps, () => new MapOwnAirplanePropsModule)
      .withModule(MapSystemKeys.FollowAirplane, () => new MapFollowAirplaneModule())
      .withTargetControlModerator()
      .withController<MapFollowAirplaneController, MapFollowAirplaneControllerModules, any, any, MapFollowAirplaneControllerContext>(
        MapSystemKeys.FollowAirplane,
        context => new MapFollowAirplaneController(context)
      );
  }

  /**
   * Configures this builder to generate a map which supports common rotation behavior. The rotation behavior will be
   * active if and only if the controller owns the rotation control resource. The controller's priority for the
   * resource is `0`.
   *
   * Requires the module `'ownAirplaneProps': MapOwnAirplanePropsModule` to support player airplane-derived rotation
   * behavior, such as Heading Up and Track Up.
   *
   * Adds the following...
   *
   * Context properties:
   * * `'[MapSystemKeys.RotationControl]': ResourceModerator<void>`
   *
   * Modules:
   * * `[MapSystemKeys.Rotation]: MapRotationModule`
   *
   * Controllers:
   * * `[MapSystemKeys.Rotation]: MapRotationController`
   * @returns This builder, after it has been configured.
   */
  public withRotation(): this {
    return this
      .withModule(MapSystemKeys.Rotation, () => new MapRotationModule())
      .withRotationControlModerator()
      .withController<MapRotationController, MapRotationControllerModules, any, any, MapRotationControllerContext>(
        MapSystemKeys.Rotation,
        context => new MapRotationController(context)
      );
  }

  /**
   * Configures this builder to generate a map which displays an icon depicting the position of the player airplane.
   *
   * Adds the following...
   *
   * Modules:
   * * `[MapSystemKeys.OwnAirplaneProps]: MapOwnAirplanePropsModule`
   * * `[MapSystemKeys.OwnAirplaneIcon]: MapOwnAirplaneIconModule`
   *
   * Layers:
   * * `[MapSystemKeys.OwnAirplaneIcon]: MapOwnAirplaneLayer`
   * @param iconSize The size of the icon, in pixels.
   * @param iconFilePath The path to the icon's image asset, or a subscribable which provides it.
   * @param iconAnchor The point on the icon that is anchored to the airplane's position, or a subscribable which
   * provides it. The point is expressed as a 2-tuple relative to the icon's width and height, with `[0, 0]` at the
   * top left and `[1, 1]` at the bottom right.
   * @param cssClass The CSS class(es) to apply to the root of the airplane icon layer.
   * @param order The order assigned to the icon layer. Layers with lower assigned order will be attached to the map
   * before and appear below layers with greater assigned order values. Defaults to the number of layers already added
   * to this builder.
   * @returns This builder, after it has been configured.
   */
  public withOwnAirplaneIcon(
    iconSize: number,
    iconFilePath: string | Subscribable<string>,
    iconAnchor: ReadonlyFloat64Array | Subscribable<ReadonlyFloat64Array>,
    cssClass?: string | SubscribableSet<string>,
    order?: number
  ): this {
    return this
      .withModule(MapSystemKeys.OwnAirplaneProps, () => new MapOwnAirplanePropsModule())
      .withModule(MapSystemKeys.OwnAirplaneIcon, () => new MapOwnAirplaneIconModule())
      .withLayer<MapOwnAirplaneLayer, MapOwnAirplaneLayerModules>(MapSystemKeys.OwnAirplaneIcon, (context): VNode => {
        return (
          <MapOwnAirplaneLayer
            model={context.model}
            mapProjection={context.projection}
            imageFilePath={typeof iconFilePath === 'string' ? Subject.create(iconFilePath) : iconFilePath}
            iconSize={iconSize}
            iconAnchor={'isSubscribable' in iconAnchor ? iconAnchor : Subject.create(iconAnchor)}
            class={cssClass}
          />
        );
      }, order);
  }




  /**
   * Configures this builder to generate a map which includes a layer displaying text.
   *
   * Adds the following...
   *
   * Context properties:
   * * `[MapSystemKeys.TextManager]: MapCullableTextLabelManager`
   *
   * Layers:
   * * `[MapSystemKeys.TextLayer]: MapCullableTextLayer`
   * @param enableCulling Whether to enable text culling. Defaults to `false`.
   * @param order The order value to assign to the text layer. Layers with lower assigned order will be attached to
   * the map before and appear below layers with greater assigned order values. Defaults to the number of layers
   * already added to this builder.
   * @returns This builder, after it has been configured.
   */
  public withTextLayer(enableCulling: boolean, order?: number): this {
    return this.withContext(MapSystemKeys.TextManager, () => new MapCullableTextLabelManager(enableCulling))
      .withLayer(MapSystemKeys.TextLayer, (context): VNode => {
        return (
          <MapCullableTextLayer
            model={context.model}
            mapProjection={context.projection}
            manager={context.textManager}
          />
        );
      }, order);
  }

  /**
   * Configures this builder to generate a map which displays Bing Map terrain and weather.
   *
   * Adds the following...
   *
   * Modules:
   * * `[MapSystemKeys.TerrainColors]: MapTerrainColorsModule`
   * * `[MapSystemKeys.Weather]: MapWxrModule`
   *
   * Layers:
   * * `[MapSystemKeys.Bing]: MapBingLayer`
   * @param bingId The ID to assign to the Bing Map instance bound to the layer.
   * @param delay The delay, in milliseconds, to wait after the Bing layer has been rendered before attempting to bind
   * a Bing Map instance.
   * @param mode The mode of the map, optional. If omitted, will be EBingMode.PLANE.
   * @param order The order value to assign to the Bing layer. Layers with lower assigned order will be attached to the
   * map before and appear below layers with greater assigned order values. Defaults to the number of layers already
   * added to the map builder.
   * @returns This builder, after it has been configured.
   */
  public withBing(
    bingId: string,
    delay = 0,
    mode?: EBingMode,
    order?: number
  ): this {
    return this
      .withModule(MapSystemKeys.TerrainColors, () => new MapTerrainColorsModule())
      .withModule(MapSystemKeys.Weather, () => new MapWxrModule())
      .withLayer<MapBingLayer, {
        [MapSystemKeys.TerrainColors]: MapTerrainColorsModule,
        [MapSystemKeys.Weather]: MapWxrModule
      }>(MapSystemKeys.Bing, context => {
        const terrainColors = context.model.getModule('terrainColors');
        const weather = context.model.getModule('weather');

        return (
          <MapBingLayer
            model={context.model}
            mapProjection={context.projection}
            bingId={bingId}
            reference={terrainColors.reference}
            earthColors={terrainColors.colors}
            isoLines={terrainColors.showIsoLines}
            wxrMode={weather.wxrMode}
            mode={mode}
            delay={delay}
          />
        );
      }, order);
  }




  /**
   * Configures this builder using a custom build step.
   * @param builder A function which defines a custom build step.
   * @param args Arguments to pass to the custom build function.
   * @returns This builder, after it has been configured.
   */
  public with<
    Builder extends MapSystemCustomBuilder<any[], any, any>,
    UseModules = any,
    UseLayers extends LayerRecord = any,
    UseContext = any
  >(
    builder: Builder,
    ...args: CustomBuilderArgs<Builder>
  ): ConditionalReturn<
    DefaultIfAny<UseModules, Modules>,
    RequiredCustomBuilderModules<Builder>,
    DefaultIfAny<UseLayers, Layers>,
    RequiredCustomBuilderLayers<Builder>,
    DefaultIfAny<UseContext, Context>,
    RequiredCustomBuilderContext<Builder>,
    this
  > {
    return builder(this, ...args) as any;
  }

  /**
   * Compiles a map. The compiled map consists of a map context, a rendered map (as a VNode), and a node reference to
   * the rendered map component.
   *
   * The compiled map will be bound to a model (accessible through the map context) which contains all the modules
   * added to this builder.
   *
   * The map will also contain all layers added to this builder, with layers assigned lower order values appearing
   * below layers assigned greater order values. The layers can be retrieved by their keys from the map context.
   *
   * All controllers added to this builder will be created with the map and hooked up to the map's lifecycle callbacks.
   * The controllers can be retrieved by their keys from the map context.
   * @param cssClass The CSS class(es) to apply to the root of the rendered map component.
   * @returns A compiled map.
   */
  public build<
    UseModules = any,
    UseLayers extends LayerRecord = any,
    UseControllers extends ControllerRecord = any,
    UseContext = any
  >(
    cssClass?: string | SubscribableSet<string>
  ): CompiledMapSystem<
    DefaultIfAny<UseModules, Modules>,
    DefaultIfAny<UseLayers, Layers>,
    DefaultIfAny<UseControllers, Controllers>,
    DefaultIfAny<UseContext, Context>
  > {
    const context = this.buildContext();

    const controllers: MapSystemController<any, any, any>[] = [];

    const ref = FSComponent.createRef<MapSystemComponent<MapSystemComponentProps<DefaultIfAny<UseModules, Modules>>>>();

    const onAfterRender = (): void => {
      for (let i = 0; i < controllers.length; i++) {
        if (!controllers[i].isAlive) {
          controllers.splice(i, 1);
          i--;
        }

        try {
          controllers[i].onAfterMapRender(ref.instance);
        } catch (e) {
          console.error(`MapSystem: error in controller .onAfterMapRender() callback: ${e}`);
          if (e instanceof Error) {
            console.error(e.stack);
          }
        }
      }
    };

    const onDeadZoneChanged = (deadZone: ReadonlyFloat64Array): void => {
      for (let i = 0; i < controllers.length; i++) {
        if (!controllers[i].isAlive) {
          controllers.splice(i, 1);
          i--;
        }

        try {
          controllers[i].onDeadZoneChanged(deadZone);
        } catch (e) {
          console.error(`MapSystem: error in controller .onDeadZoneChanged() callback: ${e}`);
          if (e instanceof Error) {
            console.error(e.stack);
          }
        }
      }
    };

    const onMapProjectionChanged = (mapProjection: MapProjection, changeFlags: number): void => {
      for (let i = 0; i < controllers.length; i++) {
        if (!controllers[i].isAlive) {
          controllers.splice(i, 1);
          i--;
        }

        try {
          controllers[i].onMapProjectionChanged(mapProjection, changeFlags);
        } catch (e) {
          console.error(`MapSystem: error in controller .onMapProjectionChanged() callback: ${e}`);
          if (e instanceof Error) {
            console.error(e.stack);
          }
        }
      }
    };

    const onBeforeUpdated = (time: number, elapsed: number): void => {
      for (let i = 0; i < controllers.length; i++) {
        if (!controllers[i].isAlive) {
          controllers.splice(i, 1);
          i--;
        }

        try {
          controllers[i].onBeforeUpdated(time, elapsed);
        } catch (e) {
          console.error(`MapSystem: error in controller .onBeforeUpdated() callback: ${e}`);
          if (e instanceof Error) {
            console.error(e.stack);
          }
        }
      }

      context.projection.applyQueued();
    };

    const onAfterUpdated = (time: number, elapsed: number): void => {
      for (let i = 0; i < controllers.length; i++) {
        if (!controllers[i].isAlive) {
          controllers.splice(i, 1);
          i--;
        }

        try {
          controllers[i].onAfterUpdated(time, elapsed);
        } catch (e) {
          console.error(`MapSystem: error in controller .onAfterUpdated() callback: ${e}`);
          if (e instanceof Error) {
            console.error(e.stack);
          }
        }
      }
    };

    const onWake = (): void => {
      for (let i = 0; i < controllers.length; i++) {
        if (!controllers[i].isAlive) {
          controllers.splice(i, 1);
          i--;
        }

        try {
          controllers[i].onWake();
        } catch (e) {
          console.error(`MapSystem: error in controller .onWake() callback: ${e}`);
          if (e instanceof Error) {
            console.error(e.stack);
          }
        }
      }
    };

    const onSleep = (): void => {
      for (let i = 0; i < controllers.length; i++) {
        if (!controllers[i].isAlive) {
          controllers.splice(i, 1);
          i--;
        }

        try {
          controllers[i].onSleep();
        } catch (e) {
          console.error(`MapSystem: error in controller .onSleep() callback: ${e}`);
          if (e instanceof Error) {
            console.error(e.stack);
          }
        }
      }
    };

    const onDestroy = (): void => {
      for (let i = 0; i < controllers.length; i++) {
        if (!controllers[i].isAlive) {
          controllers.splice(i, 1);
          i--;
        }

        try {
          controllers[i].onMapDestroyed();
        } catch (e) {
          console.error(`MapSystem: error in controller .onMapDestroyed() callback: ${e}`);
          if (e instanceof Error) {
            console.error(e.stack);
          }
        }
      }
    };

    const map = (
      <MapSystemComponent<MapSystemComponentProps<Modules>>
        ref={ref}
        model={context.model}
        projection={context.projection}
        bus={context.bus}
        projectedSize={this.projectedSize}
        onAfterRender={onAfterRender}
        onDeadZoneChanged={onDeadZoneChanged}
        onMapProjectionChanged={onMapProjectionChanged}
        onBeforeUpdated={onBeforeUpdated}
        onAfterUpdated={onAfterUpdated}
        onWake={onWake}
        onSleep={onSleep}
        onDestroy={onDestroy}
        class={cssClass}
      >
        {Array.from(this.layerFactories.values()).sort((a, b) => a.order - b.order).map(factory => {
          const node = factory.factory(context);
          context.setLayer(factory.key, node.instance as Layers[keyof Layers]);
          return node;
        })}
      </MapSystemComponent>
    );

    const controllerEntries = Array.from(this.controllerFactories)
      .map(([key, factory]) => [key, factory.factory(context)] as const);

    for (const [key, controller] of controllerEntries) {
      context.setController(key, controller as Controllers[keyof Controllers]);
    }

    controllers.push(...controllerEntries.map(([, controller]) => controller));

    for (const callback of this.initCallbacks.values()) {
      callback(context);
    }

    return { context, map, ref };
  }

  /**
   * Builds a new map context. The map context will be initialized with all context properties and modules added to
   * this builder.
   * @returns The new map context.
   */
  protected buildContext(): MutableMapContext<MapSystemContext<any, any, any, any>> {
    const context = new DefaultMapSystemContext<Modules>(
      this.bus,
      new MapProjection(this.projectedSize.get()[0], this.projectedSize.get()[1]),
      this.projectedSize,
      this.deadZone ?? VecNSubject.createFromVector(new Float64Array(4))
    ) as unknown as MutableMapContext<MapSystemContext<Modules, Layers, Controllers, Context>>;

    context.projection.set({
      targetProjectedOffset: this.targetOffset,
      rangeEndpoints: this.nominalRangeEndpoints !== undefined
        ? MapSystemUtils.nominalToTrueRelativeXY(this.nominalRangeEndpoints, context.projectedSize.get(), context.deadZone.get(), Vec2Math.create())
        : undefined,
      range: this.range
    });

    for (const factory of Array.from(this.contextFactories.values()).sort((a, b) => a.order - b.order)) {
      context[factory.key as keyof MapSystemContext<Modules, Layers, Controllers, Context>] = factory.factory(context);
    }

    for (const factory of this.moduleFactories.values()) {
      context.model.addModule(factory.key, factory.factory());
    }

    return context;
  }
}

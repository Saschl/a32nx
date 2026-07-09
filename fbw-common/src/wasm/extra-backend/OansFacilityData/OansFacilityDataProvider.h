// Copyright (c) 2026 FlyByWire Simulations
// SPDX-License-Identifier: GPL-3.0

#ifndef FLYBYWIRE_OANSFACILITYDATAPROVIDER_H
#define FLYBYWIRE_OANSFACILITYDATAPROVIDER_H

#include <cstdint>
#include <string>
#include <vector>

#include "DataManager.h"
#include "Module.h"

class MsfsHandler;

/**
 * OansFacilityDataProvider serves airport ground layout data (runways, taxiway network, parking
 * stands) to the OANC/OANS JS instruments via the CommBus, sourced from the SimConnect facility
 * data API. This is used as an alternative map data source to the Navigraph AMDB service.
 *
 * Protocol:
 * - JS requests an airport via CommBus event "FBW_OANS_FACILITY_REQUEST" with a JSON payload
 *   of the form {"requestId":<number>,"icao":"<icao>"}.
 * - The module requests the airport facility from the sim and replies with one or more CommBus
 *   events "FBW_OANS_FACILITY_REPLY", each carrying "<requestId>;<chunkIndex>;<chunkCount>;<data>"
 *   where the concatenated data chunks form a JSON document with the raw facility data
 *   (see serializeAirportData() for the exact format).
 * - If the airport cannot be loaded, a single-chunk reply with {"found":false} is sent.
 */
class OansFacilityDataProvider : public Module {
  // Facility data structs. The layout must match the field order added via
  // SimConnect_AddToFacilityDefinition() in initialize() (fields are packed in request order,
  // doubles first to keep natural alignment).

  struct AirportData {
    double lat;
    double lon;
    double alt;
    float  magvar;
    char   name[32];
  } __attribute__((packed));

  struct RunwayData {
    double  lat;
    double  lon;
    double  alt;
    float   heading;
    float   length;
    float   width;
    int32_t surface;
    int32_t primaryNumber;
    int32_t primaryDesignator;
    int32_t secondaryNumber;
    int32_t secondaryDesignator;
    int8_t  primaryClosed;
    int8_t  secondaryClosed;
  } __attribute__((packed));

  struct PavementData {
    float   length;
    float   width;
    int32_t enable;
  } __attribute__((packed));

  struct TaxiPointData {
    int32_t type;
    int32_t orientation;
    float   biasX;
    float   biasZ;
  } __attribute__((packed));

  struct TaxiParkingData {
    int32_t  type;
    int32_t  name;
    int32_t  suffix;
    uint32_t number;
    float    heading;
    float    radius;
    float    biasX;
    float    biasZ;
  } __attribute__((packed));

  struct TaxiPathData {
    int32_t  type;
    float    width;
    int32_t  runwayNumber;
    int32_t  runwayDesignator;
    int32_t  centerLine;
    int32_t  start;
    int32_t  end;
    uint32_t nameIndex;
  } __attribute__((packed));

  struct TaxiNameData {
    char name[32];
  } __attribute__((packed));

  // Runway with the threshold/blastpad/overrun pavements of both ends
  struct Runway {
    RunwayData   data{};
    PavementData primaryThreshold{};
    PavementData primaryBlastpad{};
    PavementData primaryOverrun{};
    PavementData secondaryThreshold{};
    PavementData secondaryBlastpad{};
    PavementData secondaryOverrun{};
  };

 private:
  DataManager* dataManager = nullptr;

  SIMCONNECT_DATA_DEFINITION_ID facilityDefinitionId = 0;
  SIMCONNECT_DATA_REQUEST_ID    facilityRequestId    = 0;

  // set by the CommBus callback, consumed in update()
  bool        requestPending = false;
  std::string requestedIcao;
  int64_t     jsRequestId = 0;

  // state of the in-flight facility request
  bool    requestBusy      = false;
  double  requestStartTime = 0.0;
  int64_t busyJsRequestId  = 0;

  // collected facility data
  bool                         airportReceived = false;
  AirportData                  airport{};
  std::vector<Runway>          runways;
  std::vector<TaxiPointData>   taxiPoints;
  std::vector<TaxiParkingData> taxiParkings;
  std::vector<TaxiPathData>    taxiPaths;
  std::vector<std::string>     taxiNames;
  int                          pavementCounter = 0;

 public:
  OansFacilityDataProvider() = delete;

  explicit OansFacilityDataProvider(MsfsHandler& msfsHandler) : Module(msfsHandler) {}

  bool initialize() override;
  bool preUpdate(sGaugeDrawData*) override { return true; }
  bool update(sGaugeDrawData* pData) override;
  bool postUpdate(sGaugeDrawData*) override { return true; }
  bool shutdown() override;

 private:
  /**
   * CommBus callback for "FBW_OANS_FACILITY_REQUEST" - the context is the module instance.
   */
  static void onFacilityRequest(const char* buf, unsigned int bufSize, void* ctx);

  /**
   * Adds all fields of the airport facility definition via SimConnect_AddToFacilityDefinition.
   * @return true if all fields were added successfully
   */
  bool buildFacilityDefinition();

  /**
   * Called by the DataManager for every facility data message of our request.
   */
  void onFacilityData(const SIMCONNECT_RECV_FACILITY_DATA* pData);

  /**
   * Called by the DataManager when the facility data transmission has ended.
   */
  void onFacilityDataEnd(const SIMCONNECT_RECV_FACILITY_DATA_END* pData);

  /**
   * Clears all collected facility data for a new request.
   */
  void clearCollectedData();

  /**
   * Serializes the collected facility data into the reply JSON document.
   */
  std::string serializeAirportData() const;

  /**
   * Sends a reply string to JS via CommBus, split into chunks.
   */
  void sendReply(int64_t requestId, const std::string& data) const;

  /**
   * Escapes a string for embedding into a JSON document.
   */
  static std::string escapeJson(const char* str, size_t maxLen);
};

#endif  // FLYBYWIRE_OANSFACILITYDATAPROVIDER_H

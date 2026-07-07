// Copyright (c) 2026 FlyByWire Simulations
// SPDX-License-Identifier: GPL-3.0

#include <cstdlib>
#include <cstring>

#include <MSFS/MSFS_CommBus.h>

#include <fmt/core.h>

#include "OansFacilityDataProvider.h"
#include "logging.h"

static constexpr const char* REQUEST_EVENT = "FBW_OANS_FACILITY_REQUEST";
static constexpr const char* REPLY_EVENT   = "FBW_OANS_FACILITY_REPLY";

// maximum data payload per CommBus reply chunk
static constexpr size_t CHUNK_SIZE = 8000;

// if a facility request does not complete within this time (e.g. unknown ICAO, for which the
// sim only raises a SimConnect exception and never sends FACILITY_DATA_END), fail the request
static constexpr double REQUEST_TIMEOUT_SECONDS = 10.0;

bool OansFacilityDataProvider::initialize() {
  dataManager = &msfsHandler.getDataManager();

  facilityDefinitionId = dataManager->reserveDataDefinitionId();
  facilityRequestId    = dataManager->reserveDataRequestId();

  if (!buildFacilityDefinition()) {
    LOG_ERROR("OansFacilityDataProvider: failed to build the airport facility definition");
    return false;
  }

  dataManager->addFacilityDataCallback(
      facilityRequestId,  //
      [this](const SIMCONNECT_RECV_FACILITY_DATA* pData) { onFacilityData(pData); },
      [this](const SIMCONNECT_RECV_FACILITY_DATA_END* pData) { onFacilityDataEnd(pData); });

  fsCommBusRegister(REQUEST_EVENT, &OansFacilityDataProvider::onFacilityRequest, this);

  _isInitialized = true;
  LOG_INFO("OansFacilityDataProvider initialized");
  return true;
}

bool OansFacilityDataProvider::shutdown() {
  _isInitialized = false;
  fsCommBusUnregisterOneEvent(REQUEST_EVENT, &OansFacilityDataProvider::onFacilityRequest, this);
  dataManager->removeFacilityDataCallback(facilityRequestId);
  LOG_INFO("OansFacilityDataProvider::shutdown()");
  return true;
}

bool OansFacilityDataProvider::update(sGaugeDrawData*) {
  if (!_isInitialized) {
    return false;
  }

  // fail a request that never completed (e.g. unknown ICAO - the sim only raises an exception)
  if (requestBusy && msfsHandler.getTimeStamp() - requestStartTime > REQUEST_TIMEOUT_SECONDS) {
    LOG_WARN("OansFacilityDataProvider: facility request timed out");
    sendReply(busyJsRequestId, R"({"found":false})");
    requestBusy = false;
  }

  if (requestPending && !requestBusy) {
    requestPending = false;
    clearCollectedData();

    if (!SUCCEEDED(SimConnect_RequestFacilityData(dataManager->getSimConnectHandle(), facilityDefinitionId, facilityRequestId,
                                                  requestedIcao.c_str()))) {
      LOG_ERROR("OansFacilityDataProvider: SimConnect_RequestFacilityData failed for " + requestedIcao);
      sendReply(jsRequestId, R"({"found":false})");
      return true;
    }

    requestBusy      = true;
    requestStartTime = msfsHandler.getTimeStamp();
    busyJsRequestId  = jsRequestId;
  }

  return true;
}

void OansFacilityDataProvider::onFacilityRequest(const char* buf, unsigned int bufSize, void* ctx) {
  const auto instance = static_cast<OansFacilityDataProvider*>(ctx);
  if (instance == nullptr || buf == nullptr || bufSize == 0 || buf[bufSize - 1] != '\0') {
    LOG_ERROR("OansFacilityDataProvider: received invalid facility request message");
    return;
  }

  const std::string msg{buf};

  // minimal JSON parsing of {"requestId":<number>,"icao":"<icao>"} (a UTF-8 BOM may be prepended)
  const size_t idPos = msg.find("\"requestId\"");
  const size_t icaoPos = msg.find("\"icao\"");
  if (idPos == std::string::npos || icaoPos == std::string::npos) {
    LOG_ERROR("OansFacilityDataProvider: malformed facility request: " + msg);
    return;
  }

  const size_t idColon = msg.find(':', idPos);
  const size_t icaoColon = msg.find(':', icaoPos);
  const size_t icaoQuoteStart = msg.find('"', icaoColon + 1);
  const size_t icaoQuoteEnd = icaoQuoteStart == std::string::npos ? std::string::npos : msg.find('"', icaoQuoteStart + 1);
  if (idColon == std::string::npos || icaoQuoteStart == std::string::npos || icaoQuoteEnd == std::string::npos) {
    LOG_ERROR("OansFacilityDataProvider: malformed facility request: " + msg);
    return;
  }

  instance->jsRequestId    = std::strtoll(msg.c_str() + idColon + 1, nullptr, 10);
  instance->requestedIcao  = msg.substr(icaoQuoteStart + 1, icaoQuoteEnd - icaoQuoteStart - 1);
  instance->requestPending = true;

  LOG_INFO("OansFacilityDataProvider: facility request for " + instance->requestedIcao);
}

bool OansFacilityDataProvider::buildFacilityDefinition() {
  const HANDLE hSimConnect = dataManager->getSimConnectHandle();

  // Field order MUST match the structs in the header.
  // Only fields available in both MSFS 2020 and MSFS 2024 are used, as the A32NX and A380X
  // packages target different simulator versions.
  const char* fields[] = {
      "OPEN AIRPORT",                                                                                    //
      "LATITUDE", "LONGITUDE", "ALTITUDE", "MAGVAR", "NAME",                                             //
      "OPEN RUNWAY",                                                                                     //
      "LATITUDE", "LONGITUDE", "ALTITUDE", "HEADING", "LENGTH", "WIDTH", "SURFACE",                      //
      "PRIMARY_NUMBER", "PRIMARY_DESIGNATOR", "SECONDARY_NUMBER", "SECONDARY_DESIGNATOR",                //
      "OPEN PRIMARY_THRESHOLD", "LENGTH", "WIDTH", "ENABLE", "CLOSE PRIMARY_THRESHOLD",                  //
      "OPEN SECONDARY_THRESHOLD", "LENGTH", "WIDTH", "ENABLE", "CLOSE SECONDARY_THRESHOLD",              //
      "CLOSE RUNWAY",                                                                                    //
      "OPEN TAXI_POINT",                                                                                 //
      "TYPE", "ORIENTATION", "BIAS_X", "BIAS_Z",                                                         //
      "CLOSE TAXI_POINT",                                                                                //
      "OPEN TAXI_PARKING",                                                                               //
      "TYPE", "NAME", "SUFFIX", "NUMBER", "HEADING", "RADIUS", "BIAS_X", "BIAS_Z",                       //
      "CLOSE TAXI_PARKING",                                                                              //
      "OPEN TAXI_PATH",                                                                                  //
      "TYPE", "WIDTH", "RUNWAY_NUMBER", "RUNWAY_DESIGNATOR", "CENTER_LINE", "START", "END", "NAME_INDEX",//
      "CLOSE TAXI_PATH",                                                                                 //
      "OPEN TAXI_NAME",                                                                                  //
      "NAME",                                                                                            //
      "CLOSE TAXI_NAME",                                                                                 //
      "CLOSE AIRPORT",                                                                                   //
  };

  for (const char* field : fields) {
    if (!SUCCEEDED(SimConnect_AddToFacilityDefinition(hSimConnect, facilityDefinitionId, field))) {
      LOG_ERROR("OansFacilityDataProvider: SimConnect_AddToFacilityDefinition failed for field " + std::string(field));
      return false;
    }
  }

  return true;
}

void OansFacilityDataProvider::clearCollectedData() {
  airportReceived = false;
  airport         = {};
  runways.clear();
  taxiPoints.clear();
  taxiParkings.clear();
  taxiPaths.clear();
  taxiNames.clear();
  pavementCounter = 0;
}

void OansFacilityDataProvider::onFacilityData(const SIMCONNECT_RECV_FACILITY_DATA* pData) {
  const void* data = &pData->Data;

  switch (pData->Type) {
    case SIMCONNECT_FACILITY_DATA_AIRPORT:
      std::memcpy(&airport, data, sizeof(AirportData));
      airportReceived = true;
      break;

    case SIMCONNECT_FACILITY_DATA_RUNWAY: {
      Runway runway{};
      std::memcpy(&runway.data, data, sizeof(RunwayData));
      runways.push_back(runway);
      pavementCounter = 0;
      break;
    }

    case SIMCONNECT_FACILITY_DATA_PAVEMENT: {
      // primary and secondary threshold arrive in request order after their parent runway
      PavementData pavement{};
      std::memcpy(&pavement, data, sizeof(PavementData));
      if (!runways.empty()) {
        const float length = pavement.enable != 0 ? pavement.length : 0.f;
        if (pavementCounter == 0) {
          runways.back().primaryThresholdLength = length;
        } else if (pavementCounter == 1) {
          runways.back().secondaryThresholdLength = length;
        }
        pavementCounter++;
      }
      break;
    }

    case SIMCONNECT_FACILITY_DATA_TAXI_POINT: {
      TaxiPointData point{};
      std::memcpy(&point, data, sizeof(TaxiPointData));
      taxiPoints.push_back(point);
      break;
    }

    case SIMCONNECT_FACILITY_DATA_TAXI_PARKING: {
      TaxiParkingData parking{};
      std::memcpy(&parking, data, sizeof(TaxiParkingData));
      taxiParkings.push_back(parking);
      break;
    }

    case SIMCONNECT_FACILITY_DATA_TAXI_PATH: {
      TaxiPathData path{};
      std::memcpy(&path, data, sizeof(TaxiPathData));
      taxiPaths.push_back(path);
      break;
    }

    case SIMCONNECT_FACILITY_DATA_TAXI_NAME: {
      TaxiNameData name{};
      std::memcpy(&name, data, sizeof(TaxiNameData));
      taxiNames.push_back(escapeJson(name.name, sizeof(name.name)));
      break;
    }

    default:
      break;
  }
}

void OansFacilityDataProvider::onFacilityDataEnd(const SIMCONNECT_RECV_FACILITY_DATA_END*) {
  if (!requestBusy) {
    return;
  }
  requestBusy = false;

  if (!airportReceived) {
    sendReply(busyJsRequestId, R"({"found":false})");
    return;
  }

  LOG_INFO(fmt::format("OansFacilityDataProvider: sending {} runways, {} taxi points, {} taxi paths, {} parkings for {}",
                       runways.size(), taxiPoints.size(), taxiPaths.size(), taxiParkings.size(), requestedIcao));

  sendReply(busyJsRequestId, serializeAirportData());
}

std::string OansFacilityDataProvider::serializeAirportData() const {
  std::string json;
  json.reserve(64 * 1024);

  json += fmt::format(R"({{"found":true,"icao":"{}","name":"{}","lat":{:.8f},"lon":{:.8f},"alt":{:.1f},"magvar":{:.2f})",
                      escapeJson(requestedIcao.c_str(), requestedIcao.size()), escapeJson(airport.name, sizeof(airport.name)),
                      airport.lat, airport.lon, airport.alt, airport.magvar);

  json += ",\"runways\":[";
  for (size_t i = 0; i < runways.size(); i++) {
    const Runway& rwy = runways[i];
    json += fmt::format(R"({}{{"lat":{:.8f},"lon":{:.8f},"alt":{:.1f},"hdg":{:.2f},"len":{:.1f},"wid":{:.1f},"surf":{},)"
                        R"("pnum":{},"pdes":{},"snum":{},"sdes":{},"pthr":{:.1f},"sthr":{:.1f}}})",
                        i > 0 ? "," : "", rwy.data.lat, rwy.data.lon, rwy.data.alt, rwy.data.heading, rwy.data.length, rwy.data.width,
                        rwy.data.surface, rwy.data.primaryNumber, rwy.data.primaryDesignator, rwy.data.secondaryNumber,
                        rwy.data.secondaryDesignator, rwy.primaryThresholdLength, rwy.secondaryThresholdLength);
  }

  json += "],\"points\":[";
  for (size_t i = 0; i < taxiPoints.size(); i++) {
    const TaxiPointData& point = taxiPoints[i];
    json += fmt::format("{}[{},{},{:.2f},{:.2f}]", i > 0 ? "," : "", point.type, point.orientation, point.biasX, point.biasZ);
  }

  json += "],\"parkings\":[";
  for (size_t i = 0; i < taxiParkings.size(); i++) {
    const TaxiParkingData& parking = taxiParkings[i];
    json += fmt::format("{}[{},{},{},{},{:.2f},{:.2f},{:.2f},{:.2f}]", i > 0 ? "," : "", parking.type, parking.name, parking.suffix,
                        parking.number, parking.heading, parking.radius, parking.biasX, parking.biasZ);
  }

  json += "],\"paths\":[";
  for (size_t i = 0; i < taxiPaths.size(); i++) {
    const TaxiPathData& path = taxiPaths[i];
    json += fmt::format("{}[{},{:.2f},{},{},{},{},{},{}]", i > 0 ? "," : "", path.type, path.width, path.runwayNumber,
                        path.runwayDesignator, path.centerLine, path.start, path.end, path.nameIndex);
  }

  json += "],\"names\":[";
  for (size_t i = 0; i < taxiNames.size(); i++) {
    json += fmt::format("{}\"{}\"", i > 0 ? "," : "", taxiNames[i]);
  }
  json += "]}";

  return json;
}

void OansFacilityDataProvider::sendReply(int64_t requestId, const std::string& data) const {
  const size_t chunkCount = data.empty() ? 1 : (data.size() + CHUNK_SIZE - 1) / CHUNK_SIZE;

  for (size_t i = 0; i < chunkCount; i++) {
    const std::string chunk = fmt::format("{};{};{};{}", requestId, i, chunkCount, data.substr(i * CHUNK_SIZE, CHUNK_SIZE));
    // send the terminating NUL as well so the JS side receives a proper string
    fsCommBusCall(REPLY_EVENT, chunk.c_str(), chunk.size() + 1, FsCommBusBroadcast_JS);
  }
}

std::string OansFacilityDataProvider::escapeJson(const char* str, size_t maxLen) {
  std::string result;
  result.reserve(maxLen);
  for (size_t i = 0; i < maxLen && str[i] != '\0'; i++) {
    const char c = str[i];
    if (c == '"' || c == '\\') {
      result += '\\';
      result += c;
    } else if (static_cast<unsigned char>(c) >= 0x20) {
      result += c;
    }
  }
  return result;
}

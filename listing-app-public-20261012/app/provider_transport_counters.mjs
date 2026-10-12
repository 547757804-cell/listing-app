/** Derive outbound-request counts only from evidence that transport began. */
export function providerTransportCounters({ attempts = [], providerDispatchAttempted = false, fallbackHttpStatus = null } = {}) {
  const rows = Array.isArray(attempts) ? attempts : [];
  let externalRequests = rows.filter(item => item?.outbound_transport_started === true || item?.response_received === true || Number(item?.http_status) > 0).length;
  const providerHttpResponseReceived = rows.some(item => item?.response_received === true || Number(item?.http_status) > 0)
    || (fallbackHttpStatus !== null && fallbackHttpStatus !== undefined && Number(fallbackHttpStatus) > 0);
  if (externalRequests === 0 && providerHttpResponseReceived) externalRequests = 1;
  return {
    provider_dispatch_attempted: providerDispatchAttempted === true,
    outbound_transport_started: externalRequests > 0,
    outbound_transport_started_count: externalRequests,
    provider_http_response_received: providerHttpResponseReceived,
    external_requests: externalRequests,
  };
}

-- pg_net was installed for the durable restaurant dispatcher. Its delivery queue
-- contains short-lived job tokens and must not be readable by client roles.
revoke all on table net.http_request_queue, net._http_response from public, anon, authenticated;

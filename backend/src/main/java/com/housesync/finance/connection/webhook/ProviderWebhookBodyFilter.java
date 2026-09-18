package com.housesync.finance.connection.webhook;

import com.housesync.identity.ratelimit.SlidingWindowRateLimiter;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ReadListener;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletInputStream;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import jakarta.servlet.http.HttpServletResponse;
import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.time.Clock;
import java.time.Duration;
import java.util.Locale;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Admission guard for the exact provider webhook route (connected-finance contract §5). It rejects
 * oversized bodies with 413, non-JSON content with 400, and abusive request rates with 429 before
 * any verification work, and it caches the original bytes so the controller and the verifier hash
 * exactly what the provider signed. Only {@code POST /api/provider-webhooks/plaid} is affected.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE + 100)
public class ProviderWebhookBodyFilter extends OncePerRequestFilter {

  static final String WEBHOOK_PATH = "/api/provider-webhooks/plaid";
  static final int MAX_BODY_BYTES = 1024 * 1024;
  private static final int RATE_LIMIT = 240;
  private static final Duration RATE_WINDOW = Duration.ofMinutes(1);

  private final SlidingWindowRateLimiter limiter;

  public ProviderWebhookBodyFilter(Clock clock) {
    this.limiter = new SlidingWindowRateLimiter(clock, 4096);
  }

  @Override
  protected boolean shouldNotFilter(HttpServletRequest request) {
    return !(WEBHOOK_PATH.equals(request.getRequestURI())
        && "POST".equalsIgnoreCase(request.getMethod()));
  }

  @Override
  protected void doFilterInternal(
      HttpServletRequest request, HttpServletResponse response, FilterChain chain)
      throws ServletException, IOException {
    String contentType = request.getContentType();
    if (contentType == null
        || !contentType.toLowerCase(Locale.ROOT).startsWith("application/json")) {
      response.setStatus(HttpServletResponse.SC_BAD_REQUEST);
      response.setHeader("Cache-Control", "no-store");
      return;
    }
    long declared = request.getContentLengthLong();
    if (declared > MAX_BODY_BYTES) {
      response.setStatus(HttpServletResponse.SC_REQUEST_ENTITY_TOO_LARGE);
      response.setHeader("Cache-Control", "no-store");
      return;
    }
    String remote = request.getRemoteAddr() == null ? "unknown" : request.getRemoteAddr();
    if (limiter.tryAcquire("plaid-webhook:" + remote, RATE_LIMIT, RATE_WINDOW).isPresent()) {
      response.setStatus(429);
      response.setHeader("Cache-Control", "no-store");
      return;
    }
    byte[] body;
    try {
      body = readBounded(request.getInputStream());
    } catch (BodyTooLargeException oversized) {
      response.setStatus(HttpServletResponse.SC_REQUEST_ENTITY_TOO_LARGE);
      response.setHeader("Cache-Control", "no-store");
      return;
    } catch (IOException malformed) {
      response.setStatus(HttpServletResponse.SC_BAD_REQUEST);
      response.setHeader("Cache-Control", "no-store");
      return;
    }
    chain.doFilter(new CachedBodyRequest(request, body), response);
  }

  private static byte[] readBounded(ServletInputStream stream) throws IOException {
    ByteArrayOutputStream buffer = new ByteArrayOutputStream();
    byte[] chunk = new byte[8192];
    int read;
    while ((read = stream.read(chunk)) != -1) {
      if (buffer.size() + read > MAX_BODY_BYTES) {
        throw new BodyTooLargeException();
      }
      buffer.write(chunk, 0, read);
    }
    return buffer.toByteArray();
  }

  private static final class BodyTooLargeException extends IOException {}

  /** Re-readable exact-byte request wrapper; the cached array never leaves the request. */
  private static final class CachedBodyRequest extends HttpServletRequestWrapper {

    private final byte[] body;

    CachedBodyRequest(HttpServletRequest request, byte[] body) {
      super(request);
      this.body = body;
    }

    @Override
    public ServletInputStream getInputStream() {
      ByteArrayInputStream source = new ByteArrayInputStream(body);
      return new ServletInputStream() {
        @Override
        public int read() {
          return source.read();
        }

        @Override
        public int read(byte[] target, int offset, int length) {
          return source.read(target, offset, length);
        }

        @Override
        public boolean isFinished() {
          return source.available() == 0;
        }

        @Override
        public boolean isReady() {
          return true;
        }

        @Override
        public void setReadListener(ReadListener readListener) {
          throw new UnsupportedOperationException();
        }
      };
    }

    @Override
    public BufferedReader getReader() {
      return new BufferedReader(new InputStreamReader(getInputStream(), StandardCharsets.UTF_8));
    }

    @Override
    public long getContentLengthLong() {
      return body.length;
    }
  }
}

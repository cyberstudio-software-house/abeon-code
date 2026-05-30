# Build context = repo root.  docker build -f CloudService/Dockerfile .
FROM rust:1-bookworm AS builder
WORKDIR /build
COPY crates/ crates/
COPY CloudService/ CloudService/
RUN cargo build --release --manifest-path CloudService/Cargo.toml

FROM gcr.io/distroless/cc-debian12 AS runtime
WORKDIR /app
COPY --from=builder /build/CloudService/target/release/cloudservice /app/cloudservice
# migrations are embedded at compile time via sqlx::migrate!; no runtime copy needed.
USER nonroot:nonroot
ENV BIND_ADDR=0.0.0.0:8080
EXPOSE 8080
ENTRYPOINT ["/app/cloudservice"]

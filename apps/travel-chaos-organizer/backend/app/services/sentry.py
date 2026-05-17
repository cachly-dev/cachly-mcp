def init(dsn: str = "", environment: str = "production", release: str = "0.1.0") -> None:
    if not dsn:
        return
    import sentry_sdk
    sentry_sdk.init(
        dsn=dsn,
        environment=environment,
        release=release,
        traces_sample_rate=0.05,
        profiles_sample_rate=0.01,
    )

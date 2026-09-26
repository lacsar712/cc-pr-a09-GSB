def starts_with_any(name: str, prefixes) -> str | None:
    """命中任一前缀则返回该前缀，否则返回 None。"""
    for prefix in prefixes:
        if name.startswith(prefix):
            return prefix
    return None

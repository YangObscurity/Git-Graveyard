# -*- coding: utf-8 -*-
"""Legacy helper that keeps Python 2 residue the Grimoire never rewrites."""


def dump(value, stream=None):
    print >>stream, "value:", value
    if value <> None:
        return value
    return None

#!/usr/bin/env python3
"""A stand-in for the AWS CLI that models the few KMS and STS calls company-key.sh makes, for
test-company-key.sh. State is one JSON file ($FAKE_AWS_STATE); every call is appended to $FAKE_AWS_LOG.
Knobs: FAKE_AWS_ACCOUNT, FAKE_AWS_ROLE (the role the caller "assumed"), FAKE_AWS_NORMALISE=1 (KMS hands a
policy back with one-element lists unwrapped, as IAM-style services may), FAKE_AWS_FAIL=<operation>."""
import datetime
import json
import os
import sys
import uuid


def fail(code, op, message):
    sys.stderr.write(f"\nAn error occurred ({code}) when calling the {op} operation: {message}\n")
    sys.exit(254)


def unwrap(v):
    if isinstance(v, list):
        v = [unwrap(x) for x in v]
        return v[0] if len(v) == 1 else v
    if isinstance(v, dict):
        return {k: unwrap(x) for k, x in v.items()}
    return v


def main():
    args = sys.argv[1:]
    with open(os.environ["FAKE_AWS_LOG"], "a") as f:
        f.write(" ".join(args) + "\n")
    path = os.environ["FAKE_AWS_STATE"]
    state = json.load(open(path)) if os.path.exists(path) else {"keys": {}, "aliases": {}}
    service, op = args[0], args[1]
    opts, i = {}, 2
    while i < len(args):
        if args[i].startswith("--"):
            name, vals = args[i][2:], []
            i += 1
            while i < len(args) and not args[i].startswith("--"):
                vals.append(args[i])
                i += 1
            opts[name] = vals
        else:
            i += 1
    acct = os.environ.get("FAKE_AWS_ACCOUNT", "111122223333")
    if os.environ.get("FAKE_AWS_FAIL") == op:
        fail("AccessDeniedException", op, "not allowed")

    def one(name):
        return opts[name][0]

    def meta(kid):
        k = state["keys"][kid]
        m = {
            "KeyId": kid, "Arn": f"arn:aws:kms:ap-south-1:{acct}:key/{kid}", "KeyState": k["state"],
            "KeyManager": "CUSTOMER", "KeySpec": "SYMMETRIC_DEFAULT", "KeyUsage": "ENCRYPT_DECRYPT",
            "MultiRegion": False, "Origin": "AWS_KMS",
        }
        if k.get("deletion"):
            m["DeletionDate"] = k["deletion"]
        return m

    def resolve(ident, opname):
        if ident.startswith("alias/"):
            if ident not in state["aliases"]:
                fail("NotFoundException", opname, f"Alias arn:aws:kms:ap-south-1:{acct}:{ident} is not found.")
            return state["aliases"][ident]
        if ident not in state["keys"]:
            fail("NotFoundException", opname, f"Key {ident} is not found.")
        return ident

    out = {}
    if service == "sts" and op == "get-caller-identity":
        role = os.environ.get("FAKE_AWS_ROLE", "oryxa-fde-dev-company-key-provisioner")
        out = {"Account": acct, "Arn": f"arn:aws:sts::{acct}:assumed-role/{role}/session", "UserId": "AROAEXAMPLE:session"}
    elif service == "kms" and op == "describe-key":
        out = {"KeyMetadata": meta(resolve(one("key-id"), "DescribeKey"))}
    elif service == "kms" and op == "create-key":
        kid = str(uuid.uuid4())
        tags = {}
        for t in opts.get("tags", []):
            kv = dict(p.split("=", 1) for p in t.split(","))
            tags[kv["TagKey"]] = kv["TagValue"]
        policy = json.loads(one("policy"))
        state["keys"][kid] = {
            "state": "Enabled", "tags": tags, "rotation": False,
            "policy": json.dumps(unwrap(policy) if os.environ.get("FAKE_AWS_NORMALISE") else policy, indent=2),
        }
        out = {"KeyMetadata": meta(kid)}
    elif service == "kms" and op == "create-alias":
        name = one("alias-name")
        if name in state["aliases"]:
            fail("AlreadyExistsException", "CreateAlias", f"An alias with the name {name} already exists")
        state["aliases"][name] = resolve(one("target-key-id"), "CreateAlias")
    elif service == "kms" and op == "enable-key-rotation":
        state["keys"][resolve(one("key-id"), "EnableKeyRotation")]["rotation"] = True
    elif service == "kms" and op == "get-key-rotation-status":
        out = {"KeyRotationEnabled": state["keys"][resolve(one("key-id"), "GetKeyRotationStatus")]["rotation"]}
    elif service == "kms" and op == "get-key-policy":
        out = {"Policy": state["keys"][resolve(one("key-id"), "GetKeyPolicy")]["policy"]}
    elif service == "kms" and op == "put-key-policy":
        policy = json.loads(one("policy"))
        state["keys"][resolve(one("key-id"), "PutKeyPolicy")]["policy"] = json.dumps(
            unwrap(policy) if os.environ.get("FAKE_AWS_NORMALISE") else policy, indent=2)
    elif service == "kms" and op == "list-resource-tags":
        tags = state["keys"][resolve(one("key-id"), "ListResourceTags")]["tags"]
        out = {"Tags": [{"TagKey": k, "TagValue": v} for k, v in tags.items()], "Truncated": False}
    elif service == "kms" and op == "schedule-key-deletion":
        kid = resolve(one("key-id"), "ScheduleKeyDeletion")
        days = int(one("pending-window-in-days"))
        when = (datetime.datetime(2026, 11, 10) + datetime.timedelta(days=days)).strftime("%Y-%m-%dT00:00:00+00:00")
        state["keys"][kid].update(state="PendingDeletion", deletion=when)
        out = {"KeyId": kid, "DeletionDate": when, "KeyState": "PendingDeletion", "PendingWindowInDays": days}
    else:
        fail("UnknownOperation", op, "the fake does not model this call")
    json.dump(state, open(path, "w"))
    print(json.dumps(out))


main()

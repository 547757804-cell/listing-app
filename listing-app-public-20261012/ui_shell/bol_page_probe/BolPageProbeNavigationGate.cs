using System;
using System.Collections.Generic;

namespace BOLAuto.BolPageProbe
{
    /// <summary>
    /// Enforces one explicit navigation operation per call. A failed target cannot
    /// be called again unless the caller supplies evidence that names the exact
    /// failed operation. This class has no WebView2 or network dependency.
    /// </summary>
    public sealed class NavigationFailureGate
    {
        private sealed class FailureRecord
        {
            public string OperationId;
        }

        private readonly Dictionary<string, FailureRecord> failures =
            new Dictionary<string, FailureRecord>(StringComparer.OrdinalIgnoreCase);
        private readonly HashSet<string> usedOperationIds =
            new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        private readonly Dictionary<string, int> operationCounts =
            new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        private readonly HashSet<string> activeObservedTargets =
            new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        private string activeOperationId;
        private string activeTarget;
        private int activeAttemptNumber;

        public bool TryBegin(
            string url,
            string operationId,
            string previousFailedOperationId,
            string evidenceRef,
            out int attemptNumber,
            out string errorCode)
        {
            attemptNumber = 0;
            errorCode = null;
            string target = NormalizeTarget(url);
            if (target == null)
            {
                errorCode = "NAVIGATION_TARGET_INVALID";
                return false;
            }
            Guid parsedOperationId;
            if (!Guid.TryParse(operationId, out parsedOperationId))
            {
                errorCode = "NAVIGATION_OPERATION_ID_INVALID";
                return false;
            }
            string normalizedOperationId = parsedOperationId.ToString("N");
            if (usedOperationIds.Contains(normalizedOperationId))
            {
                errorCode = "NAVIGATION_OPERATION_ID_REUSED";
                return false;
            }
            if (!String.IsNullOrEmpty(activeOperationId))
            {
                errorCode = "NAVIGATION_OPERATION_ALREADY_ACTIVE";
                return false;
            }

            FailureRecord previousFailure;
            bool hasFailure = failures.TryGetValue(target, out previousFailure);
            bool hasRecoveryFields = !String.IsNullOrWhiteSpace(previousFailedOperationId) ||
                                     !String.IsNullOrWhiteSpace(evidenceRef);
            if (hasFailure)
            {
                if (!String.Equals(previousFailure.OperationId, NormalizeFailureToken(previousFailedOperationId), StringComparison.OrdinalIgnoreCase) ||
                    !IsValidEvidenceRef(evidenceRef))
                {
                    errorCode = "NAVIGATION_RECOVERY_EVIDENCE_REQUIRED";
                    return false;
                }
                string recoveredOperationId = previousFailure.OperationId;
                foreach (string failedTarget in new List<string>(failures.Keys))
                {
                    FailureRecord failure;
                    if (failures.TryGetValue(failedTarget, out failure) &&
                        String.Equals(failure.OperationId, recoveredOperationId, StringComparison.OrdinalIgnoreCase))
                        failures.Remove(failedTarget);
                }
            }
            else if (hasRecoveryFields)
            {
                errorCode = "NAVIGATION_RECOVERY_EVIDENCE_WITHOUT_FAILURE";
                return false;
            }

            int priorCount;
            operationCounts.TryGetValue(target, out priorCount);
            attemptNumber = priorCount + 1;
            operationCounts[target] = attemptNumber;
            activeOperationId = normalizedOperationId;
            activeTarget = target;
            activeAttemptNumber = attemptNumber;
            activeObservedTargets.Clear();
            activeObservedTargets.Add(target);
            usedOperationIds.Add(normalizedOperationId);
            return true;
        }

        public bool SeedPriorFailure(string url, string priorFailureToken, string evidenceRef, out string errorCode)
        {
            errorCode = null;
            string target = NormalizeTarget(url);
            string normalizedToken = NormalizeFailureToken(priorFailureToken);
            if (target == null) { errorCode = "NAVIGATION_TARGET_INVALID"; return false; }
            if (normalizedToken == null || !IsValidEvidenceRef(evidenceRef))
            {
                errorCode = "NAVIGATION_RECOVERY_EVIDENCE_INVALID";
                return false;
            }
            if (!String.IsNullOrEmpty(activeOperationId))
            {
                errorCode = "NAVIGATION_OPERATION_ALREADY_ACTIVE";
                return false;
            }
            if (failures.ContainsKey(target))
            {
                errorCode = "NAVIGATION_PRIOR_FAILURE_ALREADY_SEEDED";
                return false;
            }
            failures[target] = new FailureRecord { OperationId = normalizedToken };
            return true;
        }

        public bool ObserveNavigationStarting(string url)
        {
            string target = NormalizeTarget(url);
            if (target == null) return true;
            if (failures.ContainsKey(target)) return true;
            if (!String.IsNullOrEmpty(activeOperationId))
            {
                activeObservedTargets.Add(target);
                return false;
            }
            return false;
        }

        public bool Complete(string operationId, string url, bool succeeded, out string errorCode)
        {
            errorCode = null;
            string normalizedOperationId = NormalizeOperationId(operationId);
            string target = NormalizeTarget(url);
            if (String.IsNullOrEmpty(activeOperationId) ||
                !String.Equals(activeOperationId, normalizedOperationId, StringComparison.OrdinalIgnoreCase) ||
                !String.Equals(activeTarget, target, StringComparison.OrdinalIgnoreCase))
            {
                errorCode = "NAVIGATION_OPERATION_COMPLETION_MISMATCH";
                return false;
            }

            if (succeeded)
            {
                foreach (string observedTarget in activeObservedTargets) failures.Remove(observedTarget);
            }
            else
            {
                foreach (string observedTarget in activeObservedTargets)
                    failures[observedTarget] = new FailureRecord { OperationId = activeOperationId };
            }
            activeOperationId = null;
            activeTarget = null;
            activeAttemptNumber = 0;
            activeObservedTargets.Clear();
            return true;
        }

        public string ActiveOperationId { get { return activeOperationId; } }
        public string ActiveTarget { get { return activeTarget; } }
        public int ActiveAttemptNumber { get { return activeAttemptNumber; } }

        public string FailedOperationIdFor(string url)
        {
            string target = NormalizeTarget(url);
            FailureRecord record;
            return target != null && failures.TryGetValue(target, out record) ? record.OperationId : null;
        }

        public static string NormalizeTarget(string value)
        {
            Uri uri;
            if (!Uri.TryCreate(value, UriKind.Absolute, out uri) ||
                !String.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase) ||
                !(String.Equals(uri.Host, "bol.com", StringComparison.OrdinalIgnoreCase) ||
                  uri.Host.EndsWith(".bol.com", StringComparison.OrdinalIgnoreCase))) return null;
            return uri.GetLeftPart(UriPartial.Path).TrimEnd('/');
        }

        private static string NormalizeOperationId(string value)
        {
            Guid id;
            return Guid.TryParse(value, out id) ? id.ToString("N") : null;
        }

        private static string NormalizeFailureToken(string value)
        {
            string operationId = NormalizeOperationId(value);
            if (operationId != null) return operationId;
            if (String.IsNullOrWhiteSpace(value) || value.Length != 71 ||
                !value.StartsWith("legacy-", StringComparison.OrdinalIgnoreCase)) return null;
            for (int i = 7; i < value.Length; i++)
            {
                char c = Char.ToLowerInvariant(value[i]);
                if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return null;
            }
            return value.ToLowerInvariant();
        }

        private static bool IsValidEvidenceRef(string value)
        {
            return !String.IsNullOrWhiteSpace(value) && value.Length <= 512 &&
                   value.IndexOfAny(new[] { '\r', '\n', '\0' }) < 0;
        }
    }
}

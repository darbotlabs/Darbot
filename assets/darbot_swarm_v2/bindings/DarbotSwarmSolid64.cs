using System.Drawing;

namespace Darbot.Swarm;

public sealed record DarbotAgentPerspective(int Index, string TokenId, string AgentId, string Hex, string Domain, string Persona, string Perspective)
{
    public Color Color => ColorTranslator.FromHtml(Hex);
}

public static class DarbotSwarmSolid64
{
    public static readonly DarbotAgentPerspective[] All =
    {
        new(1, "DSW64-01", "azure_architect", "#00CFFF", "Azure", "Cloud Architect", "Landing zones, resiliency, platform architecture"),
        new(2, "DSW64-02", "entra_identity", "#00C0F6", "Microsoft Entra", "Identity Guardian", "Zero Trust identity, conditional access, lifecycle governance"),
        new(3, "DSW64-03", "teams_collaboration", "#00B0ED", "Microsoft Teams", "Collaboration Conductor", "Meetings, channels, teamwork patterns, real-time collaboration"),
        new(4, "DSW64-04", "power_platform_maker", "#00A1E3", "Power Platform", "Fusion Maker", "Low-code strategy, app portfolios, maker enablement"),
        new(5, "DSW64-05", "power_apps_creator", "#0092DA", "Power Apps", "App Creator", "Canvas apps, model-driven apps, UX patterns"),
        new(6, "DSW64-06", "power_automate_orchestrator", "#0083D1", "Power Automate", "Flow Orchestrator", "Workflow automation, approvals, event-driven operations"),
        new(7, "DSW64-07", "power_bi_analyst", "#0074C7", "Power BI", "Insight Analyst", "Metrics, semantic models, executive dashboards"),
        new(8, "DSW64-08", "power_pages_portal", "#0066BE", "Power Pages", "Portal Maker", "Secure portals, external users, citizen services"),
        new(9, "DSW64-09", "m365_strategist", "#0056B5", "Microsoft 365", "Productivity Strategist", "Work orchestration across mail, files, meetings, and knowledge"),
        new(10, "DSW64-10", "copilot_studio_agent_builder", "#0047AB", "Copilot Studio", "Agent Builder", "Agent design, topics, actions, evaluation, governance"),
        new(11, "DSW64-11", "powerpoint_storyteller", "#394AB0", "PowerPoint", "Storytelling Expert", "Executive narrative, presentation design, visual hierarchy"),
        new(12, "DSW64-12", "excel_modeler", "#574BB4", "Excel", "Modeling Expert", "Financial models, analysis grids, formulas, scenario planning"),
        new(13, "DSW64-13", "word_writer", "#714CB9", "Word", "Technical Writer", "Docs, proposals, contracts, specs, narrative clarity"),
        new(14, "DSW64-14", "outlook_communicator", "#894ABE", "Outlook / Exchange", "Comms Strategist", "Email flow, calendaring, inbox intelligence, stakeholder comms"),
        new(15, "DSW64-15", "sharepoint_knowledge", "#A147C2", "SharePoint", "Knowledge Architect", "Intranets, content services, metadata, search, knowledge hubs"),
        new(16, "DSW64-16", "onedrive_sync", "#B942C7", "OneDrive", "File Sync Expert", "File lifecycle, personal storage, sync reliability, collaboration"),
        new(17, "DSW64-17", "edge_browser", "#D039CB", "Edge", "Browser Specialist", "Web productivity, secure browsing, enterprise browser controls"),
        new(18, "DSW64-18", "windows_os", "#E72AD0", "Windows", "Endpoint Platform Expert", "OS experience, enterprise endpoints, shell, device UX"),
        new(19, "DSW64-19", "dataverse_modeler", "#FF00D4", "Dataverse", "Data Modeler", "Tables, relationships, ALM, security roles, business data"),
        new(20, "DSW64-20", "fabric_data_engineer", "#FE24C4", "Microsoft Fabric", "Data Engineer", "Lakehouses, pipelines, warehousing, analytics fabric"),
        new(21, "DSW64-21", "azure_ai_foundry", "#FE34B4", "Azure AI Foundry", "AI Foundry Engineer", "Models, evaluations, prompt flows, agentic AI lifecycle"),
        new(22, "DSW64-22", "apim_integration", "#FE3EA3", "Azure API Management", "Integration Expert", "APIs, policies, gateways, developer portals, governance"),
        new(23, "DSW64-23", "designer_creator", "#FE4692", "Designer", "Visual Creator", "Concept art, brand assets, creative production workflows"),
        new(24, "DSW64-24", "github_engineer", "#FE4C80", "GitHub", "Software Engineer", "Repos, pull requests, Actions, Copilot coding workflows"),
        new(25, "DSW64-25", "vscode_developer", "#FE516D", "Visual Studio Code", "Developer Tools Expert", "Extensions, debugging, local dev, AI-assisted coding"),
        new(26, "DSW64-26", "devops_release", "#FE5557", "Azure DevOps", "Release Engineer", "Backlogs, pipelines, releases, environments, delivery governance"),
        new(27, "DSW64-27", "aks_platform", "#FF583C", "Azure Kubernetes Service", "Platform Engineer", "Clusters, ingress, scaling, service mesh, workload operations"),
        new(28, "DSW64-28", "functions_serverless", "#FF5A00", "Azure Functions", "Serverless Builder", "Event handlers, triggers, bindings, lightweight integration"),
        new(29, "DSW64-29", "cosmosdb_global", "#F85402", "Azure Cosmos DB", "Global Data Expert", "Distributed data, partitioning, consistency, global scale"),
        new(30, "DSW64-30", "sql_database", "#F24E04", "Azure SQL / SQL Server", "Database Expert", "Relational modeling, query performance, data integrity"),
        new(31, "DSW64-31", "graph_connector", "#EC4705", "Microsoft Graph", "Connector Expert", "Unified API, identity, mail, calendar, files, Teams integration"),
        new(32, "DSW64-32", "defender_security", "#E54107", "Microsoft Defender", "Threat Protection Expert", "Security posture, endpoint protection, threat investigation"),
        new(33, "DSW64-33", "sentinel_soc", "#DF3A08", "Microsoft Sentinel", "SOC Analyst", "SIEM, SOAR, detections, incidents, hunting"),
        new(34, "DSW64-34", "purview_governance", "#D83309", "Microsoft Purview", "Governance Officer", "Data governance, compliance, classification, risk controls"),
        new(35, "DSW64-35", "intune_endpoint", "#D22C0A", "Microsoft Intune", "Endpoint Manager", "Device compliance, app protection, endpoint fleet management"),
        new(36, "DSW64-36", "viva_employee_experience", "#CB230A", "Microsoft Viva", "Employee Experience Expert", "Engagement, learning, insights, internal comms"),
        new(37, "DSW64-37", "loop_workflows", "#C51A0B", "Microsoft Loop", "Fluid Collaboration Expert", "Components, collaborative planning, shared workspaces"),
        new(38, "DSW64-38", "planner_coordination", "#CE3C10", "Planner / To Do", "Work Coordinator", "Task boards, priorities, ownership, execution cadence"),
        new(39, "DSW64-39", "dynamics_customer", "#D65514", "Dynamics 365", "Customer Systems Expert", "CRM, ERP, customer journeys, operational processes"),
        new(40, "DSW64-40", "finance_ops", "#DE6B19", "Finance Operations", "Finance Strategist", "Forecasting, controls, billing, reporting, investment decisions"),
        new(41, "DSW64-41", "healthcare_clinical", "#E57F1D", "Healthcare", "Clinical AI Advisor", "Care workflows, clinical documentation, patient safety"),
        new(42, "DSW64-42", "retail_personalization", "#EB9322", "Retail", "Personalization Expert", "Customer segmentation, offers, recommendations, operations"),
        new(43, "DSW64-43", "manufacturing_iot", "#F1A727", "Manufacturing / IoT", "Industrial IoT Expert", "Telemetry, digital twins, factories, predictive maintenance"),
        new(44, "DSW64-44", "sustainability_greenops", "#F6BA2B", "Sustainability", "GreenOps Advisor", "Carbon, efficiency, power, circular systems, environmental impact"),
        new(45, "DSW64-45", "privacy_trust", "#FBCE30", "Privacy / Trust", "Trust Architect", "Privacy engineering, safety, responsible AI, trust boundaries"),
        new(46, "DSW64-46", "research_scientist", "#FFE135", "Research", "Research Scientist", "Hypotheses, experiments, papers, evaluation methodology"),
        new(47, "DSW64-47", "principal_architect", "#FFD030", "Architecture", "Principal Architect", "System design, trade-offs, roadmaps, executive-ready options"),
        new(48, "DSW64-48", "executive_briefing", "#FFBE2B", "Executive Strategy", "Executive Briefer", "Concise strategy, value framing, decision memos, stakeholder alignment"),
        new(49, "DSW64-49", "agent_swarm_orchestrator", "#FFAC25", "Agent Swarm", "Swarm Orchestrator", "Multi-agent planning, handoffs, consensus, control planes"),
        new(50, "DSW64-50", "red_team_adversary", "#FF9A20", "Red Team", "Adversarial Tester", "Threat modeling, jailbreaks, abuse testing, control validation"),
        new(51, "DSW64-51", "compliance_auditor", "#FF871A", "Compliance", "Compliance Auditor", "Policy mapping, evidence, controls, audit readiness"),
        new(52, "DSW64-52", "education_learning", "#FF7214", "Education", "Learning Designer", "Curriculum, tutoring, assessment, learner support"),
        new(53, "DSW64-53", "legal_contracts", "#FF5B0E", "Legal", "Contracts Expert", "Clause analysis, negotiation, legal operations, risk review"),
        new(54, "DSW64-54", "marketing_growth", "#FF3F06", "Marketing", "Growth Strategist", "Campaigns, positioning, audience, messaging, measurement"),
        new(55, "DSW64-55", "sales_enablement", "#FF0800", "Sales", "Sales Enablement Expert", "Account planning, objections, demos, value narratives"),
        new(56, "DSW64-56", "support_triage", "#FF4535", "Support", "Triage Specialist", "Case routing, symptoms, knowledge retrieval, resolution paths"),
        new(57, "DSW64-57", "observability_sre", "#FF6553", "Observability / SRE", "Reliability Engineer", "Telemetry, incidents, SLOs, RCA, production operations"),
        new(58, "DSW64-58", "storage_scale", "#FF7E6D", "Storage at Scale", "Storage Architect", "Capacity, throughput, durability, cost, power-aware infrastructure"),
        new(59, "DSW64-59", "network_edge", "#FF9586", "Networking / Edge", "Network Architect", "Traffic flow, gateways, latency, peering, edge topology"),
        new(60, "DSW64-60", "robotics_embodied", "#FFAB9E", "Robotics", "Embodied Systems Expert", "Sensors, autonomy, production systems, human-robot workflows"),
        new(61, "DSW64-61", "quantum_experiment", "#FFBFB6", "Quantum / Advanced Research", "Quantum Experimenter", "Novel algorithms, experimental design, uncertainty, frontier systems"),
        new(62, "DSW64-62", "blockchain_decentralized", "#FFD4CE", "Decentralized Systems", "Crypto / Web3 Architect", "Consensus, storage proofs, decentralized identity, resilient networks"),
        new(63, "DSW64-63", "prompt_engineer", "#FBE7E7", "Prompt Engineering", "Prompt Systems Expert", "Instructions, evals, tool behavior, prompt architecture"),
        new(64, "DSW64-64", "graphite_reviewer", "#F4FBFF", "Neutral Review", "Sober Second-Opinion Reviewer", "Clarity, critique, risk surfacing, quality gates"),
    };
}



var ko = require('../vendor/js/knockout-2.2.1.js');
var Vector2 = require('./vector2.js');
var NodeViewModel = require('./node.js').NodeViewModel;
var RefViewModel = require('./ref.js').RefViewModel;
var GraphActions = require('./git-graph-actions.js');
var ProgressBarViewModel = require('./controls.js').ProgressBarViewModel;
var md5 = require('blueimp-md5').md5;
var moment = require('moment');
var _ = require('underscore');

var GitGraphViewModel = function(repository) {
	var self = this;
	this.maxNNodes = 25;
	this.nodes = ko.observable([]);
	this.refs = ko.observableArray();
	this.daySeparators = ko.observable();
	this.nodesById = {};
	this.refsByRefName = {};
	this.repository = repository;
	this.repoPath = repository.repoPath;
	this.isLoading = ko.observable(false);
	this.nodesLoader = new ProgressBarViewModel('gitgraph-' + repository.repoPath, 1000, 400);
	this.activeBranch = ko.observable();
	this.activeRef = ko.computed(function() {
		if (self.activeBranch())
			return self.getRef('refs/heads/' + self.activeBranch());
		else
			return null;
	});
	this.HEAD = ko.observable();
	this.hoverGraphAction = ko.observable();
	this.draggingRef = ko.observable();
	this.hasRemotes = ko.observable(false);
	this.showDropTargets = ko.computed(function() {
		return !!self.draggingRef();
	});
	this.scrolledToEnd = _.debounce(function() {
		self.maxNNodes = self.maxNNodes + 25;
		self.loadNodesFromApi();
	}, 1000, true);
}
exports.GitGraphViewModel = GitGraphViewModel;
GitGraphViewModel.prototype.updateAnimationFrame = function(deltaT) {
	this.nodes().forEach(function(node) {
		node.updateAnimationFrame(deltaT);
	});
}
GitGraphViewModel.prototype.loadNodesFromApi = function() {
	var self = this;
	this.isLoading(true);
	this.nodesLoader.start();
	api.query('GET', '/log', { path: this.repoPath, limit: this.maxNNodes }, function(err, logEntries) {
		if (err) { self.nodesLoader.stop(); return; }
		self.setNodesFromLog(logEntries);
		self.isLoading(false);
		self.nodesLoader.stop();
	});
}

GitGraphViewModel.prototype.setRemoteTags = function(remoteTags) {
	var self = this;
	var nodeIdsToRemoteTags = {};
	remoteTags.forEach(function(ref) {
		if (ref.name.indexOf('^{}') != -1) {
			var name = 'remote-tag: ' + ref.name.slice(0, ref.name.length - '^{}'.length);
			var refViewModel = self.getRef(name);
			var node = self.getNode(ref.sha1);
			refViewModel.node(node);

			nodeIdsToRemoteTags[ref.sha1] = nodeIdsToRemoteTags[ref.sha1] || [];
			nodeIdsToRemoteTags[ref.sha1].push(refViewModel);
		}
	});

	for(var key in this.nodesById)
		this.nodesById[key].remoteTags(nodeIdsToRemoteTags[key] || []);
}

GitGraphViewModel.prototype.setNodesFromLog = function(nodesData) {
	var self = this;
	var nodeVMs = [];
	nodesData.forEach(function(nodeData) {
		var nodeViewModel = self.getNode(nodeData.sha1);
		nodeViewModel.setData(nodeData);
		nodeVMs.push(nodeViewModel);
		var refVMs = [];
		if (nodeData.refs) {
			var refVMs = nodeData.refs.map(function(ref) {
				var refViewModel = self.getRef(ref);
				refViewModel.node(nodeViewModel);
				return refViewModel;
			});
			nodeViewModel.branchesAndLocalTags(refVMs);
		}
	});
	this.HEAD(GitGraphViewModel.getHEAD(nodeVMs));
	this.setNodes(nodeVMs);
}
GitGraphViewModel.prototype.getNode = function(sha1) {
	var nodeViewModel = this.nodesById[sha1];
	if (!nodeViewModel) nodeViewModel = this.nodesById[sha1] = new NodeViewModel(this, sha1);
	return nodeViewModel;
}
GitGraphViewModel.prototype.getRef = function(refName) {
	var refViewModel = this.refsByRefName[refName];
	if (!refViewModel) {
		var refViewModel = this.refsByRefName[refName] = new RefViewModel({ name: refName, graph: this, color: GitGraphViewModel.colorFromHashOfString(refName) });
		this.refs.push(refViewModel);
	}
	return refViewModel;
}

GitGraphViewModel.getHEAD = function(nodes) {
	return _.find(nodes, function(node) { return _.find(node.refs(), function(r) { return r.isLocalHEAD; }); });
}

GitGraphViewModel.traverseNodeParents = function(node, nodesById, callback) {
	if (node.index() >= this.maxNNodes) return;
	callback(node);
	node.parents().forEach(function(parentId) {
		var parent = nodesById[parentId];
		if (parent)
			GitGraphViewModel.traverseNodeParents(parent, nodesById, callback);
	});
}
GitGraphViewModel.traverseNodeLeftParents = function(node, nodesById, callback) {
	if (node.index() >= this.maxNNodes) return;
	callback(node);
	var parent = nodesById[node.parents()[0]];
	if (parent)
		GitGraphViewModel.traverseNodeLeftParents(parent, nodesById, callback);
}

GitGraphViewModel.markNodesIdeologicalBranches = function(nodes, nodesById) {
	var recursivelyMarkBranch = function(e, ideologicalBranch) {
		GitGraphViewModel.traverseNodeParents(e, nodesById, function(node) {
			node.ideologicalBranch = ideologicalBranch;
		});
	}
	var getIdeologicalBranch = function(e) {
		var ref = _.find(e.refs(), function(ref) { return ref.isBranch; });
		if (ref && ref.isRemote && ref.localRef()) ref = ref.localRef();
		return ref;
	}
	var master;
	nodes.forEach(function(e) {
		var i = 0;
		var ideologicalBranch = getIdeologicalBranch(e);
		if (!ideologicalBranch) return;
		if (ideologicalBranch.name == 'refs/heads/master') master = e;
		recursivelyMarkBranch(e, ideologicalBranch);
	});
	if (master) {
		recursivelyMarkBranch(master, master.ideologicalBranch);
	}
}
GitGraphViewModel.colorFromHashOfString = function(string) {
	return '#' + md5(string).toString().slice(0, 6);
}

GitGraphViewModel.randomColor = function() {
	var randomHex = function() {
		var r = Math.floor(Math.random() * 256).toString(16);
		if (r.length == 1) r = '0' + r;
		return r;
	}
	return '#' + randomHex() + randomHex() + randomHex();
}

GitGraphViewModel.prototype.setNodes = function(nodes) {
	var daySeparators = [];
	nodes.sort(function(a, b) { return b.commitTime().unix() - a.commitTime().unix(); });
	nodes.forEach(function(node, i) { node.index(i); });
	nodes = nodes.slice(0, GitGraphViewModel.maxNNodes);

	var HEAD = this.HEAD();

	// Make sure refs know their "remote"
	for(var refName in this.refsByRefName) {
		var ref = this.refsByRefName[refName];
		if (ref.isLocalBranch) {
			var remote = this.refsByRefName['refs/remotes/origin/' + ref.displayName];
			if (remote) {
				ref.remoteRef(remote);
				remote.localRef(ref);
				remote.color = ref.color;
			}
		}
	}

	GitGraphViewModel.markNodesIdeologicalBranches(nodes, this.nodesById);

	var updateTimeStamp = moment().valueOf();

	// Mark timestamps
	if (HEAD) {
		GitGraphViewModel.traverseNodeLeftParents(HEAD, this.nodesById, function(node) {
			node.ancestorOfHEADTimeStamp = updateTimeStamp;
		});
	}

	// Filter out nodes which doesn't have a branch (staging and orphaned nodes)
	nodes = nodes.filter(function(node) { return !!node.ideologicalBranch || node.ancestorOfHEADTimeStamp == updateTimeStamp; })

	//var concurrentBranches = { };

	var branchSlots = [];
	var y = 30; // Leave room for the "commit node" (see logrednerer.js)

	// Then iterate from the bottom to fix the orders of the branches
	for (var i = nodes.length - 1; i >= 0; i--) {
		var node = nodes[i];
		if (node.ancestorOfHEADTimeStamp == updateTimeStamp) continue;
		var ideologicalBranch = node.ideologicalBranch;

		// First occurence of the branch, find an empty slot for the branch
		if (ideologicalBranch.lastSlottedTimeStamp != updateTimeStamp) {
			ideologicalBranch.lastSlottedTimeStamp = updateTimeStamp;
			var slot = 0;
			for(;slot < branchSlots.length; slot++)
				if (branchSlots[slot] === undefined) break;
			if (slot == branchSlots.length) {
				branchSlots.push(ideologicalBranch);
				slot = branchSlots.length - 1;
			}
			ideologicalBranch.branchOrder = slot;
			branchSlots[slot] = slot;
		}

		node.branchOrder = ideologicalBranch.branchOrder;

		// Free branch slots when we reach the end of a branch
		/*if (node == ideologicalBranch.node()) {
			branchSlots[ideologicalBranch.branchOrder] = undefined;
		}*/
	}

	var prevNode;
	nodes.forEach(function(node) {
		var goalPosition = new Vector2();
		if (node.ancestorOfHEADTimeStamp == updateTimeStamp) {
			if (!prevNode)
				y += 90;
			else if (prevNode.ancestorOfHEADTimeStamp == updateTimeStamp)
				y += 120;
			else
				y += 60;
			goalPosition.x = 30;
			node.setRadius(30);
			node.ancestorOfHEAD(true);
		} else {
			y += 60;
			goalPosition.x = 30 + 90 * (branchSlots.length - node.branchOrder);
			node.setRadius(15);
			node.ancestorOfHEAD(false);
		}
		goalPosition.y = y;
		node.setPosition(goalPosition);

		var secondsInADay = 60 * 60 * 24;
		if (prevNode && Math.floor(prevNode.commitTime().unix() / secondsInADay) != Math.floor(node.commitTime().unix() / secondsInADay)) {
			daySeparators.push({ x: 0, y: goalPosition.y, date: node.commitTime().format('ll') });
		}

		prevNode = node;
	});

	this.nodes(nodes);
	this.daySeparators(daySeparators);
}
